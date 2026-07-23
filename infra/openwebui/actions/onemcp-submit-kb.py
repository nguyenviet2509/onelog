"""
title: Save to OneMCP KB
author: onelog
version: 0.1.0
description: Action button 📚 — user click sau chat trace log để submit KB entry vào OneMCP.
requirements: httpx

Flow:
  1. User click nút dưới message
  2. Redact hard-block check trên transcript (raise nếu có private key/token)
  3. Summarize transcript bằng LLM cheap → {problem, solution, related, title, tags}
  4. Soft redact fields
  5. Show modal preview (OpenWebUI __event_call__ type:input) cho user edit
  6. Submit qua OneMCP submit_artifact(type=kb) → nhận {id, url}
  7. Toast success với link portal

Plan 260723-1200 Phase 2. Bot user openwebui-bot, contributor role.
"""

import json
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx
from pydantic import BaseModel, Field


# ============================================================================
# INLINED redact.py — OpenWebUI Function chỉ nhận 1 file, không có sibling import.
# Source of truth: infra/openwebui/actions/redact.py (giữ sync manual khi update).
# ============================================================================


class RedactBlocked(Exception):
    """Raised khi transcript chứa secret pattern KHÔNG cho phép submit."""

    def __init__(self, pattern_name: str, sample: str = ""):
        self.pattern_name = pattern_name
        self.sample = sample[:40]
        super().__init__(f"Blocked by {pattern_name} pattern (sample: {self.sample!r})")


HARD_BLOCK_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("pem_private_key", re.compile(r"-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----")),
    ("ssh_rsa_key", re.compile(r"ssh-rsa AAAA[A-Za-z0-9+/=]{200,}")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("gcp_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    (
        "jwt_token",
        re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b"),
    ),
]

SOFT_REDACT_RULES: list[tuple[str, re.Pattern, str]] = [
    (
        "private_ip",
        re.compile(
            r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b"
        ),
        "<REDACTED_PRIVATE_IP>",
    ),
    ("public_ip", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "<REDACTED_IP>"),
    (
        "external_email",
        re.compile(r"\b[a-zA-Z0-9._%+-]+@(?!inet\.vn\b)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b"),
        "<REDACTED_EMAIL>",
    ),
    (
        "sensitive_path",
        re.compile(r"(?:/[\w.-]+)*/(?:\.env(?:\.\w+)?|id_rsa(?:\.pub)?|credentials\.json)\b"),
        "<REDACTED_PATH>",
    ),
]


@dataclass
class RedactResult:
    text: str
    hits: dict[str, int]


def check_hard_block(text: str) -> None:
    for name, pat in HARD_BLOCK_PATTERNS:
        m = pat.search(text)
        if m:
            raise RedactBlocked(name, m.group(0))


def soft_redact(text: str) -> RedactResult:
    hits: dict[str, int] = {}
    out = text
    for name, pat, placeholder in SOFT_REDACT_RULES:
        new_out, n = pat.subn(placeholder, out)
        if n > 0:
            hits[name] = n
            out = new_out
    return RedactResult(text=out, hits=hits)


# ============================================================================
# Action class
# ============================================================================


class Action:
    class Valves(BaseModel):
        ONEMCP_URL: str = Field(default="https://192.168.122.56")
        BOT_USER: str = Field(default="openwebui-bot")
        ONEMCP_CA_PATH: str = Field(
            default="/opt/onemcp-ca.crt",
            description="Path tới OneMCP self-signed cert mounted. Rỗng = disable verify.",
        )
        TIMEOUT_SEC: float = Field(default=30.0)
        SUMMARIZER_MODEL: str = Field(
            default="deepseek",
            description="LiteLLM model dùng để tóm tắt chat. Chọn model rẻ.",
        )
        LITELLM_BASE_URL: str = Field(default="http://litellm-proxy:4000/v1")
        LITELLM_API_KEY: str = Field(
            default="", description="OpenWebUI virtual key hoặc LiteLLM master key."
        )

    def __init__(self):
        self.valves = self.Valves()
        # icon hiển thị trên nút (OpenWebUI convention)
        self.icon_url = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><text y='20' font-size='20'>📚</text></svg>"

    # ------------------------------------------------------------------ helpers

    async def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.valves.ONEMCP_URL.rstrip('/')}/api/mcp"
        headers = {"X-Onemcp-User": self.valves.BOT_USER, "Content-Type": "application/json"}
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        verify_arg: bool | str = self.valves.ONEMCP_CA_PATH or False
        async with httpx.AsyncClient(
            verify=verify_arg, timeout=self.valves.TIMEOUT_SEC
        ) as c:
            r = await c.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
        if "error" in data:
            raise RuntimeError(f"OneMCP RPC error: {data['error']}")
        return data.get("result", {})

    async def _summarize(self, transcript: str) -> dict[str, Any]:
        """Gọi LiteLLM để tóm tắt transcript thành KB draft. Trả dict theo template KB."""
        prompt = (
            "Bạn tóm tắt 1 cuộc chat trace lỗi thành entry KB. Trả JSON đúng schema:\n"
            '{"title": str (1 câu, service + triệu chứng), '
            '"problem": str (markdown, error/symptom cụ thể), '
            '"solution": str (markdown, step-by-step + commands), '
            '"related": str (markdown, links optional), '
            '"tags": [str] (max 5, snake_case)}\n'
            "Không suy diễn. Chỉ trích từ chat. Nếu chat chưa fix xong hoặc mơ hồ, "
            'trả {"error": "not_kb_worthy"}.\n\n'
            f"Chat transcript:\n---\n{transcript}\n---"
        )
        url = f"{self.valves.LITELLM_BASE_URL.rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.valves.LITELLM_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.valves.SUMMARIZER_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
        }
        async with httpx.AsyncClient(timeout=self.valves.TIMEOUT_SEC) as c:
            r = await c.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
        content = data["choices"][0]["message"]["content"]
        return json.loads(content)

    @staticmethod
    def _make_slug(title: str) -> str:
        """Generate slug từ title. OneMCP yêu cầu: lowercase alphanumeric + dashes,
        min 3 chars, max 160. Suffix epoch để tránh collision khi title trùng."""
        s = title.lower()
        # Strip diacritics VN → keep ASCII base
        for src, dst in (("đ", "d"), ("ă", "a"), ("â", "a"), ("ê", "e"),
                          ("ô", "o"), ("ơ", "o"), ("ư", "u")):
            s = s.replace(src, dst)
        s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
        s = s[:140]  # leave room for suffix
        if len(s) < 3:
            s = "kb-entry"
        return f"{s}-{int(time.time())}"

    @staticmethod
    def _transcript_from_body(body: dict[str, Any]) -> str:
        msgs = body.get("messages", [])
        lines = []
        for m in msgs:
            role = m.get("role", "?")
            content = m.get("content", "")
            if isinstance(content, list):
                content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
            lines.append(f"[{role}] {content}")
        return "\n".join(lines)

    # ------------------------------------------------------------------ action

    async def action(
        self,
        body: dict[str, Any],
        __user__: dict[str, Any] | None = None,
        __event_emitter__: Callable[[dict], Awaitable[None]] | None = None,
        __event_call__: Callable[[dict], Awaitable[Any]] | None = None,
    ) -> str | None:
        async def status(msg: str, done: bool = False) -> None:
            if __event_emitter__:
                await __event_emitter__(
                    {"type": "status", "data": {"description": msg, "done": done}}
                )

        try:
            # Stage 1 — hard-block check trên raw transcript
            await status("Kiểm tra secrets...")
            transcript = self._transcript_from_body(body)
            try:
                check_hard_block(transcript)
            except RedactBlocked as e:
                await status(f"⛔ Từ chối submit: {e.pattern_name} phát hiện", done=True)
                return f"Blocked: transcript chứa {e.pattern_name}. Xoá secret khỏi chat rồi thử lại."

            # Stage 2 — summarize (soft-redact input trước để tránh gửi PII cho LLM)
            await status("Đang tóm tắt chat (deepseek)...")
            redacted_input = soft_redact(transcript).text
            try:
                draft = await self._summarize(redacted_input)
            except Exception as e:
                await status(f"⛔ Summarizer fail: {e}", done=True)
                return f"Summarizer error: {e}"

            if draft.get("error") == "not_kb_worthy":
                await status("⚠️ Chat không đủ nội dung cho KB (chưa fix xong / mơ hồ)", done=True)
                return "Not KB-worthy: chat chưa có problem+solution rõ."

            # Stage 3 — modal preview (OpenWebUI __event_call__ type:input, V1 dependency)
            if not __event_call__:
                # Fallback: submit không preview (nếu OpenWebUI version cũ)
                edited = draft
                await status("(Không có modal API — submit direct)")
            else:
                await status("Mở modal preview...")
                edited = await __event_call__(
                    {
                        "type": "input",
                        "data": {
                            "title": "📚 Save to OneMCP KB",
                            "message": "Chỉnh lại nội dung trước khi submit. Entry sẽ ở pending — maintainer verify trong portal.",
                            "placeholder": "",
                            "fields": [
                                {"name": "title", "value": draft.get("title", ""), "multiline": False},
                                {"name": "problem", "value": draft.get("problem", ""), "multiline": True},
                                {"name": "solution", "value": draft.get("solution", ""), "multiline": True},
                                {"name": "related", "value": draft.get("related", ""), "multiline": True},
                                {"name": "tags", "value": ",".join(draft.get("tags", [])), "multiline": False},
                            ],
                        },
                    }
                )
                if not edited:
                    await status("Đã huỷ submit", done=True)
                    return "Cancelled."

            # Stage 4 — soft redact final fields trước submit
            title = soft_redact(edited.get("title", "")).text
            problem = soft_redact(edited.get("problem", "")).text
            solution = soft_redact(edited.get("solution", "")).text
            related = soft_redact(edited.get("related", "")).text
            tags = [t.strip() for t in edited.get("tags", "").split(",") if t.strip()]

            # Stage 5 — submit
            await status("Submit vào OneMCP...")
            result = await self._rpc(
                "tools/call",
                {
                    "name": "submit_artifact",
                    "arguments": {
                        "type": "kb",
                        "title": title,
                        "slug": self._make_slug(title),
                        "structured": {"problem": problem, "solution": solution, "related": related},
                        "tags": tags,
                    },
                },
            )
            aid = result.get("id") or result.get("artifact_id") or "?"
            portal_url = f"{self.valves.ONEMCP_URL.rstrip('/')}/artifacts/{aid}"
            await status(f"✅ KB #{aid} pending — {portal_url}", done=True)
            return f"Submitted KB #{aid} (pending). Verify tại: {portal_url}"

        except Exception as e:
            await status(f"⛔ Error: {type(e).__name__}: {e}", done=True)
            return f"Error: {e}"
