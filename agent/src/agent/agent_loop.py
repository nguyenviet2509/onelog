"""
Self-written tool-use loop — KISS alternative to LangGraph for MVP.

Yields events as it goes so the /chat route can pipe them out via SSE:
  {type: "thinking", text}     — assistant prose between tool calls
  {type: "tool_call", name, input, id}
  {type: "tool_result", id, output}
  {type: "answer", text, citations}     — final text after validator passes
  {type: "error", message}

Citation rule: final answer MUST contain at least one `[service:host:...]`
fragment that names a service we actually saw in a tool_result. If missing,
we re-prompt the model ONCE to add citation. If still missing, we return
"Không đủ data" — preventing silent hallucination.
"""
from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from typing import Any

from agent.config import settings
from agent.llm_client import LLMClient
from agent.logging_setup import log
from agent.system_prompt import SYSTEM_PROMPT
from agent.tools import registry

_CITATION_RE = re.compile(r"\[([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]+)(?::[^\]]+)?\]")


async def run_agent(user_query: str) -> AsyncIterator[dict[str, Any]]:
    llm = LLMClient()
    messages: list[dict[str, Any]] = [{"role": "user", "content": user_query}]
    seen_services: set[str] = set()
    seen_hosts: set[str] = set()
    final_text: str | None = None
    retry_done = False

    for turn in range(settings.agent_max_turns):
        try:
            resp = await asyncio.wait_for(
                llm.create(
                    system=SYSTEM_PROMPT,
                    messages=messages,
                    tools=registry.schemas(),
                ),
                timeout=settings.agent_timeout_s,
            )
        except asyncio.TimeoutError:
            yield {"type": "error", "message": f"LLM timeout after {settings.agent_timeout_s}s"}
            return
        except Exception as exc:  # noqa: BLE001
            log.error("agent.llm_failed", err=str(exc), turn=turn)
            yield {"type": "error", "message": f"LLM error: {exc}"}
            return

        content_blocks = resp.get("content") or []
        # Echo any prose blocks first.
        for b in content_blocks:
            if b.get("type") == "text" and b.get("text", "").strip():
                yield {"type": "thinking", "text": b["text"]}

        tool_calls = [b for b in content_blocks if b.get("type") == "tool_use"]
        if not tool_calls:
            # Model returned final text → validate citations.
            final_text = " ".join(
                b.get("text", "") for b in content_blocks if b.get("type") == "text"
            ).strip()
            break

        # Append assistant turn to history before executing tools.
        messages.append({"role": "assistant", "content": content_blocks})

        tool_results: list[dict[str, Any]] = []
        for call in tool_calls:
            name = call.get("name", "")
            args = call.get("input") or {}
            call_id = call.get("id", "")
            yield {"type": "tool_call", "name": name, "input": args, "id": call_id}

            runner = registry.get(name)
            if runner is None:
                output = {"error": f"unknown tool: {name}"}
            else:
                try:
                    output = await runner(args)
                except Exception as exc:  # noqa: BLE001
                    log.error("agent.tool_failed", tool=name, err=str(exc))
                    output = {"error": str(exc)}

            _track_provenance(output, seen_services, seen_hosts)
            yield {"type": "tool_result", "id": call_id, "output": output}
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": call_id,
                "content": json.dumps(output, default=str),
            })

        messages.append({"role": "user", "content": tool_results})
    else:
        yield {"type": "error", "message": f"Max turns ({settings.agent_max_turns}) reached without final answer"}
        return

    if final_text is None:
        yield {"type": "error", "message": "Model produced no final text"}
        return

    citations = _extract_valid_citations(final_text, seen_services, seen_hosts)
    if citations:
        yield {"type": "answer", "text": final_text, "citations": citations}
        return

    if retry_done:
        yield {
            "type": "answer",
            "text": "Không đủ data để kết luận với citation hợp lệ.",
            "citations": [],
        }
        return

    # Re-prompt once asking model to add citation, then re-validate.
    retry_done = True
    messages.append({"role": "assistant", "content": [{"type": "text", "text": final_text}]})
    messages.append({
        "role": "user",
        "content": (
            "Câu trả lời thiếu citation [service:host:timestamp] tham chiếu tool_result. "
            "Hãy viết lại trả lời, thêm citation từ dữ liệu tool đã trả về. "
            "Nếu không đủ data, nói rõ 'Không đủ data'."
        ),
    })

    try:
        resp = await asyncio.wait_for(
            llm.create(system=SYSTEM_PROMPT, messages=messages, tools=registry.schemas()),
            timeout=settings.agent_timeout_s,
        )
    except Exception as exc:  # noqa: BLE001
        yield {"type": "error", "message": f"Re-prompt failed: {exc}"}
        return

    retry_text = " ".join(
        b.get("text", "") for b in (resp.get("content") or []) if b.get("type") == "text"
    ).strip()
    citations = _extract_valid_citations(retry_text, seen_services, seen_hosts)
    if citations:
        yield {"type": "answer", "text": retry_text, "citations": citations}
    else:
        yield {
            "type": "answer",
            "text": "Không đủ data để kết luận với citation hợp lệ.",
            "citations": [],
        }


def _track_provenance(
    output: dict[str, Any], seen_services: set[str], seen_hosts: set[str]
) -> None:
    """Collect service+host strings from tool output so the validator can verify citations."""
    for key in ("hits", "lines"):
        items = output.get(key)
        if not isinstance(items, list):
            continue
        for it in items:
            if not isinstance(it, dict):
                continue
            svc = it.get("service")
            host = it.get("host")
            if isinstance(svc, str):
                seen_services.add(svc)
            if isinstance(host, str):
                seen_hosts.add(host)


def _extract_valid_citations(
    text: str, seen_services: set[str], seen_hosts: set[str]
) -> list[str]:
    """Return citations whose service AND host appear in tool results."""
    valid: list[str] = []
    for m in _CITATION_RE.finditer(text):
        svc, host = m.group(1), m.group(2)
        if svc in seen_services and host in seen_hosts:
            valid.append(m.group(0))
    return valid
