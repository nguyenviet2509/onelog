"""
LiteLLM-backed LLM client with shape adapter — provider-agnostic tool-use loop.

Keeps the Anthropic content-block interface (`content: [{type: 'text'|'tool_use'}], stop_reason`)
so `agent_loop.py` stays unchanged. Internally translates to/from OpenAI-shape
messages which LiteLLM uses as the lingua franca across providers.

Provider is selected by `settings.llm_model` (e.g. `anthropic/claude-sonnet-4-5`,
`gemini/gemini-2.5-flash`, `openai/gpt-4.1-mini`, `deepseek/deepseek-chat`).

Mock mode (`LLM_MOCK=true` or missing keys) plays a fixed two-turn script:
turn 1 → request `search_log_templates`, turn 2 → cite whatever came back.
This proves the loop, tool dispatch, and citation validator work without
burning API quota.
"""
from __future__ import annotations

import json
import os
import uuid
from typing import Any

import litellm

from agent.config import settings
from agent.logging_setup import log


# LiteLLM timeout must be < AGENT_TIMEOUT_S to avoid orphaned upstream requests
# when the agent loop times out first and double-charges (RT-F12).
_LITELLM_TIMEOUT_S = 25


class LLMClient:
    def __init__(self) -> None:
        self._model = _resolve_model()
        self._max_tokens = _resolve_max_tokens()
        self._fallbacks = _parse_fallbacks(settings.llm_fallback_models)
        self._mock = settings.llm_mock or not _has_any_provider_key(self._model)

        if self._mock:
            log.info("llm.mock_mode", reason="LLM_MOCK or no provider key", model=self._model)
            return

        _configure_env()
        log.info("llm.ready", model=self._model, fallbacks=self._fallbacks)

    async def create(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Return dict shaped like Anthropic Message: {content: [...], stop_reason: str}."""
        if self._mock:
            return _mock_response(messages)

        oai_messages = _anthropic_to_openai_messages(system, messages)
        oai_tools = _anthropic_to_openai_tools(tools)

        extra: dict[str, Any] = {}
        # [V7] Anthropic prompt caching — 65% cost reduction on repeated
        # system + tool schema. Provider-specific header; ignored elsewhere.
        if self._model.startswith("anthropic/") and settings.llm_enable_prompt_cache:
            extra["extra_headers"] = {"anthropic-beta": "prompt-caching-2024-07-31"}

        resp = await litellm.acompletion(
            model=self._model,
            messages=oai_messages,
            tools=oai_tools or None,
            max_tokens=self._max_tokens,
            timeout=_LITELLM_TIMEOUT_S,
            fallbacks=self._fallbacks or None,
            **extra,
        )
        return _openai_to_anthropic_response(resp)


# ---------- Settings resolution ----------

def _resolve_model() -> str:
    """Back-compat: legacy `anthropic_model` env still works if `llm_model` unset."""
    if settings.anthropic_model and settings.llm_model == "anthropic/claude-sonnet-4-5":
        # User set only the legacy var → honor it.
        return f"anthropic/{settings.anthropic_model}"
    return settings.llm_model


def _resolve_max_tokens() -> int:
    if settings.anthropic_max_tokens and settings.llm_max_tokens == 2048:
        return settings.anthropic_max_tokens
    return settings.llm_max_tokens


def _parse_fallbacks(csv: str) -> list[str]:
    return [m.strip() for m in csv.split(",") if m.strip()]


def _has_any_provider_key(model: str) -> bool:
    """Model prefix decides which key must exist."""
    prefix = model.split("/", 1)[0].lower()
    key_map = {
        "anthropic": settings.anthropic_api_key,
        "openai": settings.openai_api_key,
        "gemini": settings.gemini_api_key,
        "deepseek": settings.deepseek_api_key,
    }
    return bool(key_map.get(prefix))


def _configure_env() -> None:
    """Re-export keys to process env so LiteLLM's provider auto-detection picks them up."""
    pairs = {
        "ANTHROPIC_API_KEY": settings.anthropic_api_key,
        "OPENAI_API_KEY": settings.openai_api_key,
        "GEMINI_API_KEY": settings.gemini_api_key,
        "DEEPSEEK_API_KEY": settings.deepseek_api_key,
        "HTTPS_PROXY": settings.https_proxy,
    }
    for k, v in pairs.items():
        if v and not os.environ.get(k):
            os.environ[k] = v


# ---------- Anthropic ↔ OpenAI shape adapter ----------

def _anthropic_to_openai_messages(
    system: str, messages: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Convert Anthropic-style tool-use messages to OpenAI chat format.

    Anthropic assistant `tool_use` block → OpenAI assistant `tool_calls`.
    Anthropic user `tool_result` block → OpenAI `role='tool'` message.
    """
    out: list[dict[str, Any]] = [{"role": "system", "content": system}]

    for m in messages:
        role = m.get("role")
        content = m.get("content")

        if isinstance(content, str):
            out.append({"role": role, "content": content})
            continue

        if not isinstance(content, list):
            continue

        if role == "assistant":
            text_parts: list[str] = []
            tool_calls: list[dict[str, Any]] = []
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text":
                    text_parts.append(b.get("text", ""))
                elif b.get("type") == "tool_use":
                    tool_calls.append({
                        "id": b.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": b.get("name", ""),
                            "arguments": json.dumps(b.get("input") or {}),
                        },
                    })
            entry: dict[str, Any] = {"role": "assistant"}
            entry["content"] = "\n".join(t for t in text_parts if t) or None
            if tool_calls:
                entry["tool_calls"] = tool_calls
            out.append(entry)

        elif role == "user":
            # Anthropic packs tool_result blocks in a user message. OpenAI wants
            # each as a separate `role='tool'` entry.
            leftover_text: list[str] = []
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_result":
                    body = b.get("content")
                    if not isinstance(body, str):
                        body = json.dumps(body, default=str)
                    out.append({
                        "role": "tool",
                        "tool_call_id": b.get("tool_use_id", ""),
                        "content": body,
                    })
                elif b.get("type") == "text":
                    leftover_text.append(b.get("text", ""))
            if leftover_text:
                out.append({"role": "user", "content": "\n".join(leftover_text)})

    return out


def _anthropic_to_openai_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Anthropic `input_schema` → OpenAI `parameters`."""
    return [
        {
            "type": "function",
            "function": {
                "name": t.get("name", ""),
                "description": t.get("description", ""),
                "parameters": t.get("input_schema") or {"type": "object"},
            },
        }
        for t in tools
    ]


def _openai_to_anthropic_response(resp: Any) -> dict[str, Any]:
    """Convert LiteLLM (OpenAI-shape) response → Anthropic content blocks."""
    choices = getattr(resp, "choices", None) or []
    if not choices:
        raise ValueError("LLM response has no choices")

    msg = choices[0].message
    finish = choices[0].finish_reason or ""

    blocks: list[dict[str, Any]] = []
    text = getattr(msg, "content", None)
    if text:
        blocks.append({"type": "text", "text": text})

    tool_calls = getattr(msg, "tool_calls", None) or []
    for tc in tool_calls:
        fn = getattr(tc, "function", None)
        raw_args = getattr(fn, "arguments", "{}") if fn else "{}"
        try:
            parsed = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        except json.JSONDecodeError:
            log.warning("llm.tool_args_malformed", raw=raw_args[:200])
            parsed = {}
        blocks.append({
            "type": "tool_use",
            "id": getattr(tc, "id", "") or f"toolu_{uuid.uuid4().hex[:12]}",
            "name": getattr(fn, "name", "") if fn else "",
            "input": parsed,
        })

    stop_reason = "tool_use" if finish == "tool_calls" or tool_calls else "end_turn"
    return {"content": blocks, "stop_reason": stop_reason}


# ---------- Mock response (unchanged behavior) ----------

def _mock_response(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Deterministic playback: tool_use → final answer citing whatever came back."""
    has_tool_result = any(
        any(
            isinstance(b, dict) and b.get("type") == "tool_result"
            for b in (m.get("content") if isinstance(m.get("content"), list) else [])
        )
        for m in messages
    )

    if not has_tool_result:
        return {
            "content": [
                {"type": "text", "text": "Tôi sẽ tìm log template liên quan trước."},
                {
                    "type": "tool_use",
                    "id": f"toolu_{uuid.uuid4().hex[:12]}",
                    "name": "search_log_templates",
                    "input": {"query": _extract_user_query(messages), "limit": 5},
                },
            ],
            "stop_reason": "tool_use",
        }

    citation = _citation_from_tool_result(messages) or "mock-service:srv-01:2026-06-23T04:00:00Z"
    return {
        "content": [
            {
                "type": "text",
                "text": (
                    "Dựa trên log templates tìm thấy, hệ thống có cluster lỗi lặp lại.\n"
                    f"Citation: [{citation}]"
                ),
            }
        ],
        "stop_reason": "end_turn",
    }


def _extract_user_query(messages: list[dict[str, Any]]) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            content = m.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "text":
                        return str(b.get("text", ""))
    return ""


def _citation_from_tool_result(messages: list[dict[str, Any]]) -> str | None:
    """Pull first service:host:ts hint from any tool_result content for mock answer."""
    for m in messages:
        content = m.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            body = block.get("content")
            if isinstance(body, str):
                try:
                    parsed = json.loads(body)
                except json.JSONDecodeError:
                    continue
                hits = parsed.get("hits") or []
                if hits:
                    h = hits[0]
                    return f"{h.get('service','?')}:{h.get('host','?')}:{h.get('window_start','?')}"
    return None
