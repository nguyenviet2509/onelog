"""Unit tests for the LiteLLM adapter — shape conversion Anthropic ↔ OpenAI."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from agent import llm_client
from agent.llm_client import (
    _anthropic_to_openai_messages,
    _anthropic_to_openai_tools,
    _openai_to_anthropic_response,
)


# ---------- Anthropic → OpenAI ----------

def test_messages_plain_user_str_prepends_system():
    out = _anthropic_to_openai_messages("SYS", [{"role": "user", "content": "hi"}])
    assert out[0] == {"role": "system", "content": "SYS"}
    assert out[1] == {"role": "user", "content": "hi"}


def test_messages_assistant_tool_use_becomes_tool_calls():
    msgs = [
        {"role": "user", "content": "find mysql"},
        {"role": "assistant", "content": [
            {"type": "text", "text": "searching"},
            {"type": "tool_use", "id": "t1", "name": "search",
             "input": {"query": "mysql", "limit": 5}},
        ]},
    ]
    out = _anthropic_to_openai_messages("SYS", msgs)
    assistant = out[-1]
    assert assistant["role"] == "assistant"
    assert assistant["content"] == "searching"
    assert assistant["tool_calls"][0]["id"] == "t1"
    assert assistant["tool_calls"][0]["function"]["name"] == "search"
    parsed = json.loads(assistant["tool_calls"][0]["function"]["arguments"])
    assert parsed == {"query": "mysql", "limit": 5}


def test_messages_user_tool_result_becomes_role_tool():
    msgs = [
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": '{"hits":[]}'},
        ]},
    ]
    out = _anthropic_to_openai_messages("SYS", msgs)
    tool_msg = next(m for m in out if m.get("role") == "tool")
    assert tool_msg["tool_call_id"] == "t1"
    assert tool_msg["content"] == '{"hits":[]}'


def test_messages_tool_result_dict_content_gets_serialized():
    msgs = [
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": {"hits": [{"a": 1}]}},
        ]},
    ]
    out = _anthropic_to_openai_messages("SYS", msgs)
    tool_msg = next(m for m in out if m.get("role") == "tool")
    assert json.loads(tool_msg["content"]) == {"hits": [{"a": 1}]}


def test_tools_input_schema_becomes_parameters():
    tools = [{
        "name": "search_log_templates",
        "description": "search",
        "input_schema": {"type": "object", "properties": {"q": {"type": "string"}}},
    }]
    out = _anthropic_to_openai_tools(tools)
    assert out[0]["type"] == "function"
    assert out[0]["function"]["name"] == "search_log_templates"
    assert out[0]["function"]["parameters"]["properties"] == {"q": {"type": "string"}}


# ---------- OpenAI → Anthropic ----------

def _fake_resp(*, text=None, tool_calls=None, finish="stop"):
    tc_objs = []
    for tc in tool_calls or []:
        tc_objs.append(SimpleNamespace(
            id=tc["id"],
            function=SimpleNamespace(name=tc["name"], arguments=tc["arguments"]),
        ))
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content=text, tool_calls=tc_objs or None),
        finish_reason=finish,
    )])


def test_response_text_only_becomes_end_turn():
    resp = _fake_resp(text="Kết luận [svc:host:2026-01].", finish="stop")
    out = _openai_to_anthropic_response(resp)
    assert out["stop_reason"] == "end_turn"
    assert out["content"][0]["type"] == "text"
    assert "Kết luận" in out["content"][0]["text"]


def test_response_tool_calls_becomes_tool_use():
    resp = _fake_resp(
        text=None,
        tool_calls=[{"id": "t1", "name": "search", "arguments": '{"query":"mysql"}'}],
        finish="tool_calls",
    )
    out = _openai_to_anthropic_response(resp)
    assert out["stop_reason"] == "tool_use"
    tu = out["content"][0]
    assert tu["type"] == "tool_use"
    assert tu["name"] == "search"
    assert tu["input"] == {"query": "mysql"}


def test_response_mixed_text_and_tool():
    resp = _fake_resp(
        text="Let me search",
        tool_calls=[{"id": "t1", "name": "search", "arguments": "{}"}],
        finish="tool_calls",
    )
    out = _openai_to_anthropic_response(resp)
    assert out["stop_reason"] == "tool_use"
    types = [b["type"] for b in out["content"]]
    assert types == ["text", "tool_use"]


def test_response_malformed_json_args_falls_back_to_empty():
    resp = _fake_resp(
        text=None,
        tool_calls=[{"id": "t1", "name": "search", "arguments": "{not json"}],
        finish="tool_calls",
    )
    out = _openai_to_anthropic_response(resp)
    assert out["content"][0]["input"] == {}


def test_response_no_choices_raises():
    resp = SimpleNamespace(choices=[])
    with pytest.raises(ValueError):
        _openai_to_anthropic_response(resp)


# ---------- LLMClient integration (mocked litellm) ----------

@pytest.mark.asyncio
async def test_client_mock_mode_when_no_key(monkeypatch):
    from agent.config import settings
    monkeypatch.setattr(settings, "llm_mock", False)
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    monkeypatch.setattr(settings, "openai_api_key", "")
    monkeypatch.setattr(settings, "gemini_api_key", "")
    monkeypatch.setattr(settings, "deepseek_api_key", "")

    client = llm_client.LLMClient()
    resp = await client.create(system="s", messages=[{"role": "user", "content": "q"}], tools=[])
    # mock branch always emits a tool_use on first call
    assert resp["stop_reason"] == "tool_use"
    assert any(b.get("type") == "tool_use" for b in resp["content"])


@pytest.mark.asyncio
async def test_client_calls_litellm_with_normalized_shape(monkeypatch):
    """Verify LLMClient forwards OpenAI-shape messages+tools to litellm.acompletion."""
    from agent.config import settings
    monkeypatch.setattr(settings, "llm_mock", False)
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-fake")
    monkeypatch.setattr(settings, "llm_model", "anthropic/claude-sonnet-4-5")

    captured: dict = {}

    async def fake_acompletion(**kwargs):
        captured.update(kwargs)
        return _fake_resp(text="ok [svc:host:t]", finish="stop")

    monkeypatch.setattr(llm_client.litellm, "acompletion", fake_acompletion)

    client = llm_client.LLMClient()
    resp = await client.create(
        system="SYS",
        messages=[{"role": "user", "content": "hi"}],
        tools=[{"name": "t", "description": "", "input_schema": {"type": "object"}}],
    )

    assert captured["model"] == "anthropic/claude-sonnet-4-5"
    assert captured["timeout"] == 25  # RT-F12
    assert captured["messages"][0] == {"role": "system", "content": "SYS"}
    assert captured["tools"][0]["type"] == "function"
    # V7: prompt caching header injected for anthropic/*
    assert "anthropic-beta" in captured.get("extra_headers", {})
    assert resp["stop_reason"] == "end_turn"


@pytest.mark.asyncio
async def test_client_no_cache_header_for_non_anthropic(monkeypatch):
    from agent.config import settings
    monkeypatch.setattr(settings, "llm_mock", False)
    monkeypatch.setattr(settings, "gemini_api_key", "fake")
    monkeypatch.setattr(settings, "llm_model", "gemini/gemini-2.5-flash")

    captured: dict = {}

    async def fake_acompletion(**kwargs):
        captured.update(kwargs)
        return _fake_resp(text="ok", finish="stop")

    monkeypatch.setattr(llm_client.litellm, "acompletion", fake_acompletion)

    client = llm_client.LLMClient()
    await client.create(system="s", messages=[{"role": "user", "content": "hi"}], tools=[])
    assert "extra_headers" not in captured
