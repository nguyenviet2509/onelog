"""
POST /alert — Alertmanager webhook.

Per-alert flow:
  1. dedupe by fingerprint (in-memory TTL)
  2. build a triage prompt from labels/annotations
  3. run agent_loop → collect final text + citations
  4. format Markdown + push Telegram

Ack the webhook fast (return immediately) and process alerts in a background
asyncio task. Alertmanager retries by default if it doesn't hear 200 within
its send_timeout (10s) — handing back instantly avoids re-fires while a slow
LLM call is in flight.
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import httpx
from fastapi import APIRouter, Request

from agent.agent_loop import run_agent
from agent.alert_dedupe import dedupe
from agent.alert_formatter import fingerprint, format_alert
from agent.logging_setup import log
from agent.telegram_client import TelegramClient

router = APIRouter()
_telegram = TelegramClient()
_WEB_URL = os.getenv("WEB_URL", "http://web:3000")


def _triage_prompt(alert: dict[str, Any]) -> str:
    labels = alert.get("labels") or {}
    annotations = alert.get("annotations") or {}
    return (
        f"Alert `{labels.get('alertname','?')}` fired. "
        f"Host: {labels.get('host','?')}, "
        f"Service: {labels.get('service') or labels.get('category', '?')}. "
        f"Summary: {annotations.get('summary','(none)')}. "
        f"Description: {annotations.get('description','(none)')}. "
        "Tìm log template + raw lines liên quan tới host/service này trong 10 phút gần nhất, "
        "đưa ra hypothesis nguyên nhân kèm citation [service:host:timestamp]."
    )


async def _collect_triage(prompt: str) -> tuple[str, list[dict[str, Any]], bool]:
    """Drive the agent loop end-to-end.

    Returns (final_text, tool_calls, had_error). `tool_calls` mirrors the shape
    persisted by the web BFF so /admin/audit renders both sources uniformly.
    """
    final = "(no answer)"
    tool_calls: list[dict[str, Any]] = []
    had_error = False
    async for ev in run_agent(prompt):
        t = ev["type"]
        if t == "answer":
            final = ev.get("text", final)
        elif t == "tool_call":
            tool_calls.append({"name": ev.get("name", "?"), "input": ev.get("input"), "ok": True})
        elif t == "tool_result" and tool_calls:
            out = ev.get("output") or {}
            if isinstance(out, dict) and out.get("error"):
                tool_calls[-1]["ok"] = False
        elif t == "error":
            had_error = True
            log.error("alert.agent_error", err=ev.get("message"))
    return final, tool_calls, had_error


async def _persist_audit(prompt: str, tool_calls: list[dict[str, Any]], latency_ms: int, status: str) -> None:
    """Best-effort POST to web BFF; never raise into the alert pipeline."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as cli:
            await cli.post(
                f"{_WEB_URL}/api/internal/audit",
                json={
                    "source": "alert",
                    "prompt": prompt,
                    "toolCalls": tool_calls,
                    "latencyMs": latency_ms,
                    "status": status,
                },
            )
    except Exception as exc:  # noqa: BLE001
        log.warning("alert.audit_persist_failed", err=str(exc))


async def _process_one(alert: dict[str, Any]) -> None:
    fp = fingerprint(alert)
    if dedupe.seen(fp):
        log.info("alert.deduped", fingerprint=fp)
        return

    log.info("alert.processing", fingerprint=fp, alertname=(alert.get("labels") or {}).get("alertname"))
    prompt = _triage_prompt(alert)
    started = time.monotonic()
    tool_calls: list[dict[str, Any]] = []
    status = "ok"
    try:
        triage, tool_calls, had_error = await _collect_triage(prompt)
        if had_error:
            status = "error"
    except Exception as exc:  # noqa: BLE001
        log.error("alert.triage_failed", err=str(exc), fingerprint=fp)
        triage = f"_(triage failed: {exc})_"
        status = "error"

    latency_ms = int((time.monotonic() - started) * 1000)
    await _persist_audit(prompt, tool_calls, latency_ms, status)

    body = format_alert(alert, triage)
    await _telegram.send(body)


async def _process_payload(payload: dict[str, Any]) -> None:
    alerts = payload.get("alerts") or []
    # Sequential to avoid LLM rate-limit storms; alert volume is low.
    for a in alerts:
        if a.get("status") == "firing":
            await _process_one(a)


@router.post("/alert")
async def alert_webhook(request: Request) -> dict[str, str]:
    payload = await request.json()
    asyncio.create_task(_process_payload(payload))
    return {"status": "accepted"}
