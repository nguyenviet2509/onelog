"""
title: Save to OneMCP KB
author: onelog
version: 0.1.0
description: Action button 📚 — two-click submit KB. Click 1 = AI draft emit ra chat (edit in-place, full-width). Click 2 = submit draft đã edit.
requirements: httpx

Flow (two-click, không dùng modal):
  Click 1 trên LLM message:
    1. Hard-block check trên transcript
    2. Summarize bằng LLM → {problem, solution, related, title, tags}
    3. Emit draft markdown như 1 assistant message mới (user edit tại chỗ)
    4. Kết thúc, hint user edit + click 📚 lần 2

  Click 2 trên DRAFT message (đã edit hoặc chưa):
    1. Detect DRAFT_MARKER → parse markdown ngược lại structured
    2. Soft redact fields
    3. Submit qua OneMCP submit_artifact(type=kb) → nhận artifact ID
    4. Toast link portal

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
        ONEMCP_URL: str = Field(default="https://10.200.0.44")
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
            "Bạn là gatekeeper KB — CHỈ tạo entry cho chat có bug ĐÃ FIX XONG, không phải investigation.\n\n"
            "TRẢ {\"error\": \"not_kb_worthy\"} nếu chat có BẤT KỲ dấu hiệu nào:\n"
            "- User hỏi how-to / cách làm (VD: 'có cách nào', 'làm sao', 'làm thế nào', 'how to')\n"
            "- Chat đang investigation / exploration (đang tìm hiểu, chưa xác định root cause)\n"
            "- Solution chưa được verified (chỉ là hypothesis / suggestion / gợi ý)\n"
            "- Chat là thảo luận / Q&A / brainstorm\n"
            "- Không có error message cụ thể hoặc command/config thay đổi cụ thể\n"
            "- Assistant hỏi user info thêm (VD 'service nào', 'bạn muốn xem') → chưa fix xong\n\n"
            "CHỈ tạo KB entry nếu chat có ĐỦ:\n"
            "1. Bug/error CỤ THỂ với error message hoặc symptom rõ (VD: 'nginx 502 upstream timeout')\n"
            "2. Root cause đã xác định (VD: 'do proxy_read_timeout 60s quá thấp')\n"
            "3. Solution ĐÃ APPLY và VERIFIED (VD: 'set 300s + reload nginx, đã hết 502')\n"
            "4. Ít nhất 1 command hoặc config change cụ thể trong solution\n\n"
            "Schema JSON khi pass:\n"
            '{"title": str (service + triệu chứng cụ thể, KHÔNG kết thúc bằng ?), '
            '"problem": str (markdown, error message + symptom + context), '
            '"solution": str (markdown, ĐÃ VERIFIED steps + commands cụ thể trong ```), '
            '"related": str (markdown, links optional), '
            '"tags": [str] (max 5, snake_case, service + error type)}\n\n"'
            "Không suy diễn. Chỉ trích chính xác từ chat. Nghi ngờ = not_kb_worthy.\n\n"
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
    def _validate_kb_draft(draft: dict[str, Any]) -> tuple[bool, str]:
        """Strict server-side check — chỉ pass nếu title/problem/solution đủ nội dung THẬT.
        Trả (ok, reason). LLM đôi khi hallucinate draft từ chat mơ hồ nên cần double-check."""
        title = str(draft.get("title", "")).strip()
        problem = str(draft.get("problem", "")).strip()
        solution = str(draft.get("solution", "")).strip()

        # --- Title checks ---
        if len(title) < 15:
            return False, f"title quá ngắn ({len(title)} < 15 ký tự)"
        title_lower = title.lower()
        # Title là câu hỏi hoặc how-to
        question_patterns = [
            r"^(có cách|có tool|có thể|làm sao|làm thế nào|how to|why|cách nào|why is|xem thời gian|xem cách)",
            r"\?$",
            r"\b(hỏi|question|query about)\b",
        ]
        for pat in question_patterns:
            if re.search(pat, title_lower):
                return False, f"title là câu hỏi/how-to, không phải KB fix entry"

        # --- Problem checks ---
        if len(problem) < 60:
            return False, f"problem quá ngắn ({len(problem)} < 60 ký tự)"
        # Problem phải có ít nhất 1 error indicator concrete
        error_indicators = [
            r"\b(error|fail|failed|timeout|crash|down|refused|denied|invalid|panic|exception)\b",
            r"\b(5\d{2}|4\d{2})\b",  # HTTP 5xx/4xx codes
            r"\b(OOM|OOM-killed|SIGKILL|SIGTERM|SIGSEGV|core dump)\b",
            r"\b(không hoạt động|không kết nối|không phản hồi|bị treo|báo lỗi|lỗi khi|lỗi ở)\b",
            r"\b(cannot|can'?t|unable to|refused|rejected)\b",
        ]
        if not any(re.search(pat, problem, re.IGNORECASE) for pat in error_indicators):
            return False, "problem thiếu error indicator cụ thể (error code, exception, symptom)"

        # --- Solution checks ---
        if len(solution) < 60:
            return False, f"solution quá ngắn ({len(solution)} < 60 ký tự)"
        # Solution PHẢI có concrete fix artifact: code block hoặc backtick command hoặc config change
        concrete_fix = [
            r"```",                                    # code block
            r"`[a-zA-Z0-9_.\-]+(\s+[^`]+)?`",         # inline command in backticks
            r"\b(set|thêm dòng|sửa|thay|update|edit|apply|reload|restart|deploy)\s+`?[\w.-]+`?\s*[:=]",
            r"^\s*\d+[.)]\s+.{20,}",                   # numbered step >= 20 chars
        ]
        if not any(re.search(pat, solution, re.IGNORECASE | re.MULTILINE) for pat in concrete_fix):
            return False, "solution thiếu concrete fix (code block / command / config change)"

        # Solution toàn câu hỏi → reject
        solution_qs = solution.count("?")
        if solution_qs >= 3:
            return False, f"solution có {solution_qs} câu hỏi → chưa phải fix verified"

        return True, "ok"

    @staticmethod
    def _extract_artifact_id(result: Any) -> str:
        """Trích ID từ mọi format MCP tools/call có thể trả về."""
        if not isinstance(result, dict):
            return "?"
        # Flat: {id: N} hoặc {artifact_id: N}
        for k in ("id", "artifact_id", "artifactId"):
            if result.get(k):
                return str(result[k])
        # Nested: {artifact: {id: N}}
        art = result.get("artifact")
        if isinstance(art, dict) and art.get("id"):
            return str(art["id"])
        # MCP content array: [{type: text, text: "Submitted artifact #N ..."}]
        content = result.get("content", [])
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict):
                    text_body = str(item.get("text", ""))
                    m = re.search(r"artifact\s*#(\d+)", text_body, re.IGNORECASE)
                    if m:
                        return m.group(1)
                    # Regex khác: id: N | ID: N
                    m2 = re.search(r"\bid[:\s#]+(\d+)", text_body, re.IGNORECASE)
                    if m2:
                        return m2.group(1)
        return "?"

    @staticmethod
    def _draft_to_markdown(draft: dict[str, Any]) -> str:
        """Pack AI draft thành single markdown editable trong modal input."""
        title = str(draft.get("title", "")).strip() or "Untitled"
        problem = str(draft.get("problem", "")).strip()
        solution = str(draft.get("solution", "")).strip()
        related = str(draft.get("related", "")).strip()
        tags_val = draft.get("tags", [])
        if isinstance(tags_val, list):
            tags_str = ", ".join(str(t) for t in tags_val)
        else:
            tags_str = str(tags_val)
        return (
            f"# {title}\n\n"
            f"## Problem\n{problem}\n\n"
            f"## Solution\n{solution}\n\n"
            f"## Related\n{related}\n\n"
            f"## Tags\n{tags_str}\n"
        )

    @staticmethod
    def _parse_kb_markdown(text: str, fallback: dict[str, Any]) -> dict[str, Any]:
        """Parse markdown user-edited ngược lại structured KB fields.
        H1 = title. `## Problem/Solution/Related/Tags` = section content.
        Section thiếu → fallback về AI draft."""
        result: dict[str, Any] = {}
        # Title từ H1 đầu tiên
        title_m = re.search(r"^#\s+(.+?)\s*$", text, re.MULTILINE)
        result["title"] = title_m.group(1).strip() if title_m else str(fallback.get("title", ""))
        # Sections: ## Section\n<content>...</content until next ##>
        sections: dict[str, str] = {}
        for m in re.finditer(
            r"^##\s+(\w+)\s*\n(.*?)(?=^##\s+\w+|\Z)",
            text,
            re.MULTILINE | re.DOTALL,
        ):
            sections[m.group(1).lower()] = m.group(2).strip()
        result["problem"] = sections.get("problem") or str(fallback.get("problem", ""))
        result["solution"] = sections.get("solution") or str(fallback.get("solution", ""))
        result["related"] = sections.get("related") or str(fallback.get("related", ""))
        tags_raw = sections.get("tags", "")
        if tags_raw:
            result["tags"] = [t.strip() for t in re.split(r"[,\n]", tags_raw) if t.strip()]
        else:
            result["tags"] = fallback.get("tags", [])
        return result

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
            """Update status ở header (progress indicator)."""
            if __event_emitter__:
                await __event_emitter__(
                    {"type": "status", "data": {"description": msg, "done": done}}
                )

        async def toast(kind: str, msg: str) -> None:
            """Emit toast góc màn hình (best-effort, thử nhiều event schema).
            kind: success | warning | error | info."""
            if not __event_emitter__:
                return
            for payload in (
                {"type": "notification", "data": {"type": kind, "content": msg}},
                {"type": "toast", "data": {"type": kind, "content": msg}},
                {"type": "notification", "data": {"type": kind, "message": msg}},
            ):
                try:
                    await __event_emitter__(payload)
                except Exception:
                    pass

        # One-click workflow (KISS):
        #   Nếu user message cuối là KB markdown (`# Title` + `## Problem`) → submit user version
        #   Ngược lại → AI generate + submit direct
        # User muốn edit: type markdown vào chat input (full-width native), send, click 📚
        def _looks_like_kb_markdown(text: str) -> bool:
            if not text or len(text) < 30:
                return False
            has_h1 = bool(re.search(r"^#\s+\S", text, re.MULTILINE))
            has_section = bool(
                re.search(r"^##\s+(Problem|Solution)", text, re.MULTILINE | re.IGNORECASE)
            )
            return has_h1 and has_section

        try:
            transcript = self._transcript_from_body(body)
            msgs = body.get("messages", [])

            # Lấy message user cuối cùng
            last_user_content = ""
            for m in reversed(msgs):
                if m.get("role") == "user":
                    content = m.get("content", "")
                    if isinstance(content, list):
                        content = " ".join(
                            c.get("text", "") for c in content if isinstance(c, dict)
                        )
                    last_user_content = str(content)
                    break

            edited: dict[str, Any] | None = None

            if _looks_like_kb_markdown(last_user_content):
                await status("Parse KB từ message user...")
                edited = self._parse_kb_markdown(last_user_content, {})
                if not edited.get("title") or not edited.get("problem"):
                    err_msg = "⛔ KB markdown thiếu title hoặc problem"
                    await status(err_msg, done=True)
                    await toast("error", "KB markdown không hợp lệ — cần `# Title` + `## Problem` + `## Solution`")
                    return "KB markdown không hợp lệ."
            else:
                await status("Kiểm tra secrets...")
                try:
                    check_hard_block(transcript)
                except RedactBlocked as e:
                    err_msg = f"⛔ Từ chối submit: phát hiện {e.pattern_name}"
                    await status(err_msg, done=True)
                    await toast("error", f"KB blocked: transcript chứa {e.pattern_name}. Xoá secret rồi thử lại.")
                    return f"Blocked: transcript chứa {e.pattern_name}."

                await status("Đang tóm tắt chat (deepseek)...")
                redacted_input = soft_redact(transcript).text
                try:
                    edited = await self._summarize(redacted_input)
                except Exception as e:
                    err_msg = f"⛔ Summarizer fail: {e}"
                    await status(err_msg, done=True)
                    await toast("error", f"Summarizer lỗi: {type(e).__name__}")
                    return f"Summarizer error: {e}"

                if edited.get("error") == "not_kb_worthy":
                    warn_msg = "⚠️ Chat chưa đủ nội dung KB (chưa fix xong hoặc mơ hồ). Type markdown vào chat rồi click 📚 lần nữa để bypass."
                    await status("⚠️ Chat chưa đủ nội dung cho KB", done=True)
                    await toast("warning", warn_msg)
                    return "Not KB-worthy."

                # Strict server-side validation — không tin LLM 100%.
                ok, reason = self._validate_kb_draft(edited)
                if not ok:
                    warn_msg = (
                        f"⚠️ Draft không đạt: {reason}. "
                        f"Hãy type KB markdown vào chat (đủ title + problem + solution) rồi click 📚 lần nữa."
                    )
                    await status(f"⚠️ Draft rejected: {reason}", done=True)
                    await toast("warning", warn_msg)
                    return f"Draft rejected: {reason}"

            # Stage 4 — soft redact final fields trước submit
            def _field(key: str, default: Any = "") -> str:
                val = edited.get(key, default)
                if isinstance(val, list):
                    return ",".join(str(v) for v in val)
                return str(val) if val is not None else ""

            title = soft_redact(_field("title")).text
            problem = soft_redact(_field("problem")).text
            solution = soft_redact(_field("solution")).text
            related = soft_redact(_field("related")).text
            tags_raw = edited.get("tags", "")
            if isinstance(tags_raw, list):
                tags = [str(t).strip() for t in tags_raw if str(t).strip()]
            else:
                tags = [t.strip() for t in str(tags_raw).split(",") if t.strip()]

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
            print(f"[onemcp-submit-kb] submit response: {json.dumps(result)[:500]}", flush=True)
            aid: str = self._extract_artifact_id(result)
            portal_url = f"{self.valves.ONEMCP_URL.rstrip('/')}/artifacts/{aid}"
            success_msg = f"✅ KB #{aid} submit thành công (pending). {portal_url}"

            await status(f"✅ KB #{aid} pending — {portal_url}", done=True)
            await toast("success", success_msg)
            return f"Submitted KB #{aid} (pending). Verify: {portal_url}"

        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            await status(f"⛔ Error: {err}", done=True)
            await toast("error", f"KB submit lỗi: {err}")
            return f"Error: {e}"
