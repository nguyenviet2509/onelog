"""
Tool registry — maps Anthropic tool name → (schema, runner).

Each tool module exports `schema` (Anthropic spec) and `run(args) -> dict`.
The agent loop iterates Anthropic's `tool_use` blocks, looks up here, and
feeds the dict result back as `tool_result` content.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from agent.tools import query_victorialogs, search_log_templates

ToolRunner = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]

_TOOLS: dict[str, tuple[dict[str, Any], ToolRunner]] = {
    search_log_templates.schema["name"]: (search_log_templates.schema, search_log_templates.run),
    query_victorialogs.schema["name"]: (query_victorialogs.schema, query_victorialogs.run),
}


def schemas() -> list[dict[str, Any]]:
    return [s for s, _ in _TOOLS.values()]


def get(name: str) -> ToolRunner | None:
    entry = _TOOLS.get(name)
    return entry[1] if entry else None
