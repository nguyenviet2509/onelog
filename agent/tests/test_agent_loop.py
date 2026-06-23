"""
Agent loop integration test — uses LLM_MOCK and a fake tool registry so we
verify the loop wiring (tool dispatch → tool_result feedback → citation
validation) without hitting Qdrant / Anthropic.
"""
from __future__ import annotations

from typing import Any

import pytest

from agent import agent_loop
from agent.tools import registry


@pytest.fixture(autouse=True)
def _fake_search_tool(monkeypatch):
    """Swap registry to return a canned hit naming a known service+host."""
    async def fake_run(args: dict[str, Any]) -> dict[str, Any]:
        return {
            "hits": [
                {
                    "score": 0.91,
                    "template": "[ERROR] [MY-013183] Got error from storage engine",
                    "service": "mock-mysql",
                    "host": "srv-01",
                    "severity": "err",
                    "count": 42,
                    "window_start": "2026-06-23T04:00:00+00:00",
                    "window_end": "2026-06-23T04:05:00+00:00",
                    "sample": "redacted sample",
                }
            ]
        }

    fake_schema = {"name": "search_log_templates", "description": "fake", "input_schema": {"type": "object"}}
    monkeypatch.setattr(registry, "_TOOLS", {"search_log_templates": (fake_schema, fake_run)})


@pytest.mark.asyncio
async def test_loop_emits_tool_call_then_answer():
    events: list[dict[str, Any]] = []
    async for ev in agent_loop.run_agent("mysql có lỗi gì gần đây?"):
        events.append(ev)

    types = [e["type"] for e in events]
    assert "tool_call" in types, f"no tool_call in {types}"
    assert "tool_result" in types
    assert "answer" in types, f"no final answer in {types}"

    answer = next(e for e in events if e["type"] == "answer")
    assert answer["citations"], "citation extraction failed — answer must reference seen service+host"


@pytest.mark.asyncio
async def test_invalid_citation_is_rejected(monkeypatch):
    """If model cites a service/host never seen in tool results, validator must catch it."""
    # Monkeypatch LLM client to always emit a fake citation referencing nonexistent svc.
    from agent import llm_client

    class _AlwaysFakeLLM:
        async def create(self, *, system, messages, tools):
            has_result = any(
                isinstance(b, dict) and b.get("type") == "tool_result"
                for m in messages
                if isinstance(m.get("content"), list)
                for b in m["content"]
            )
            if not has_result:
                return {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "t1",
                            "name": "search_log_templates",
                            "input": {"query": "x"},
                        }
                    ],
                    "stop_reason": "tool_use",
                }
            return {
                "content": [{"type": "text", "text": "Kết luận [ghost-service:ghost-host:2026]."}],
                "stop_reason": "end_turn",
            }

    monkeypatch.setattr(llm_client, "LLMClient", _AlwaysFakeLLM)
    monkeypatch.setattr(agent_loop, "LLMClient", _AlwaysFakeLLM)

    events = [ev async for ev in agent_loop.run_agent("test")]
    answer = next(e for e in events if e["type"] == "answer")
    # Validator rejects → either retry produces nothing valid OR final answer signals lack of data.
    assert answer["citations"] == [] or "Không đủ data" in answer["text"]
