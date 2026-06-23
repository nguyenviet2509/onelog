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
from typing import Any

from fastapi import APIRouter, Request

from agent.agent_loop import run_agent
from agent.alert_dedupe import dedupe
from agent.alert_formatter import fingerprint, format_alert
from agent.logging_setup import log
from agent.telegram_client import TelegramClient

router = APIRouter()
_telegram = TelegramClient()


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


async def _collect_triage(prompt: str) -> str:
    """Drive the agent loop end-to-end, return only the final `answer` text."""
    final = "(no answer)"
    async for ev in run_agent(prompt):
        if ev["type"] == "answer":
            final = ev.get("text", final)
        elif ev["type"] == "error":
            log.error("alert.agent_error", err=ev.get("message"))
    return final


async def _process_one(alert: dict[str, Any]) -> None:
    fp = fingerprint(alert)
    if dedupe.seen(fp):
        log.info("alert.deduped", fingerprint=fp)
        return

    log.info("alert.processing", fingerprint=fp, alertname=(alert.get("labels") or {}).get("alertname"))
    try:
        triage = await _collect_triage(_triage_prompt(alert))
    except Exception as exc:  # noqa: BLE001
        log.error("alert.triage_failed", err=str(exc), fingerprint=fp)
        triage = f"_(triage failed: {exc})_"

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
