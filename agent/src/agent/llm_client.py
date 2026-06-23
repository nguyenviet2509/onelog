"""
Anthropic client wrapper with LLM_MOCK fallback.

Mock mode is for pre-key dev + deterministic tests. It plays back a fixed
two-turn script: turn 1 → request `search_log_templates`, turn 2 → answer with
a synthetic citation built from whatever tool_result was returned. This proves
the loop, tool dispatch, and citation enforcement work without burning API quota.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
from anthropic import AsyncAnthropic

from agent.config import settings
from agent.logging_setup import log


class LLMClient:
    def __init__(self) -> None:
        self._mock = settings.llm_mock or not settings.anthropic_api_key
        if self._mock:
            log.info("llm.mock_mode", reason="LLM_MOCK or no API key")
            self._client: AsyncAnthropic | None = None
            return

        http = (
            httpx.AsyncClient(proxy=settings.https_proxy)
            if settings.https_proxy
            else None
        )
        self._client = AsyncAnthropic(
            api_key=settings.anthropic_api_key,
            http_client=http,
        )

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

        assert self._client is not None
        resp = await self._client.messages.create(
            model=settings.anthropic_model,
            max_tokens=settings.anthropic_max_tokens,
            system=system,
            messages=messages,
            tools=tools,
        )
        return {
            "content": [b.model_dump() for b in resp.content],
            "stop_reason": resp.stop_reason,
        }


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
                {
                    "type": "text",
                    "text": "Tôi sẽ tìm log template liên quan trước.",
                },
                {
                    "type": "tool_use",
                    "id": f"toolu_{uuid.uuid4().hex[:12]}",
                    "name": "search_log_templates",
                    "input": {
                        "query": _extract_user_query(messages),
                        "limit": 5,
                    },
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
    """Pull first service:host:ts hint from any tool_result content for the mock answer."""
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
