"""
title: Arena Vote A wins
author: onelog
version: 0.1.1
description: 🅰️ Bấm khi Response A tốt hơn. Reveal tên 2 model + ghi vote vào arena-votes.jsonl.
requirements:
"""

# Action OpenWebUI · plan 260728-0829-openwebui-blind-arena
# 1 trong 4 vote button (a-wins, b-wins, tie, both-bad). Copy-paste theo pattern
# này, chỉ đổi VOTE_LABEL + title/description. Không tách shared module vì
# OpenWebUI functions không cross-import được.

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel

VOTES_PATH = Path("/app/backend/data/arena-votes.jsonl")
VOTE_LABEL = "A"
ARENA_KEY_RE = re.compile(r"<!--\s*arena_key=([a-f0-9]{6,32})\s*-->")


def _find_pair(arena_key: str) -> dict[str, Any] | None:
    if not VOTES_PATH.exists():
        return None
    with VOTES_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("event") == "pair" and rec.get("arena_key") == arena_key:
                return rec
    return None


def _last_assistant(messages: list[dict[str, Any]]) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "assistant":
            return msg.get("content") or ""
    return ""


class Action:
    class Valves(BaseModel):
        pass

    def __init__(self):
        self.valves = self.Valves()
        self.icon_url = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><text y='20' font-size='18'>🅰️</text></svg>"

    async def action(
        self,
        body: dict[str, Any],
        __user__: dict[str, Any] | None = None,
        __event_emitter__: Any = None,
        **kwargs,
    ) -> str | None:
        content = _last_assistant(body.get("messages", []))
        m = ARENA_KEY_RE.search(content)
        if not m:
            if __event_emitter__:
                await __event_emitter__({"type": "notification",
                    "data": {"type": "error", "content": "Không tìm thấy arena_key. Message này không phải blind-arena?"}})
            return None
        arena_key = m.group(1)
        pair = _find_pair(arena_key)
        if not pair:
            if __event_emitter__:
                await __event_emitter__({"type": "notification",
                    "data": {"type": "error", "content": f"Không tìm thấy pair {arena_key} trong JSONL."}})
            return None

        vote_record = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "event": "vote",
            "arena_key": arena_key,
            "user": (__user__ or {}).get("email") or (__user__ or {}).get("id") or "anon",
            "vote": VOTE_LABEL,
        }
        try:
            with VOTES_PATH.open("a", encoding="utf-8") as f:
                f.write(json.dumps(vote_record, ensure_ascii=False) + "\n")
        except OSError as e:
            if __event_emitter__:
                await __event_emitter__({"type": "notification",
                    "data": {"type": "error", "content": f"Ghi vote fail: {e}"}})
            return None

        reveal = (
            f"🗳️ **Vote ghi nhận: {VOTE_LABEL}**\n\n"
            f"Reveal:\n"
            f"- 🅰️ A = `{pair['model_a']}`\n"
            f"- 🅱️ B = `{pair['model_b']}`\n\n"
            f"_arena_key: `{arena_key}`_"
        )
        if __event_emitter__:
            await __event_emitter__({"type": "message", "data": {"content": reveal}})
        return None
