"""
Telegram Bot API client — minimal sendMessage wrapper + TELEGRAM_MOCK.

KISS: HTTP POST, no separate bot service. Bot service comes back in slice 2
when we need inline callbacks (ack/silence).
"""
from __future__ import annotations

from typing import Any

import httpx

from agent.config import settings
from agent.logging_setup import log


class TelegramClient:
    def __init__(self) -> None:
        self._mock = (
            settings.telegram_mock
            or not settings.telegram_bot_token
            or not settings.telegram_alert_chat_id
        )
        if self._mock:
            log.info("telegram.mock_mode", reason="TELEGRAM_MOCK or missing creds")

    async def send(self, text: str) -> dict[str, Any]:
        if self._mock:
            log.info("telegram.mock_send", body=text)
            return {"ok": True, "mock": True}

        url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage"
        payload = {
            "chat_id": settings.telegram_alert_chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
            data = resp.json()
            if not data.get("ok"):
                log.error("telegram.send_failed", body=data)
            return data
