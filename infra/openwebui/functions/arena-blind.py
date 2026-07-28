"""
title: Arena Blind
author: onelog
version: 0.1.1
description: Blind A/B compare 2 random models. Vote qua 4 action buttons riêng (arena-vote-*).
requirements:
"""

# Pipe OpenWebUI · plan 260728-0829-openwebui-blind-arena
# User chọn "Arena Blind" từ model dropdown → prompt được gửi song song tới 2
# model random từ POOL. Response gộp thành 1 message, ẩn tên model. arena_key
# (UUID) nhúng trong HTML comment cuối message → action vote lookup pair từ
# arena-votes.jsonl để append vote record + reveal.

import asyncio
import json
import random
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

VOTES_PATH = Path("/app/backend/data/arena-votes.jsonl")


class Pipe:
    class Valves(BaseModel):
        MODEL_POOL: str = Field(
            default="claude-sonnet,deepseek,gemini-flash,gpt-4-mini",
            description="Comma-separated model IDs (khớp tên trong LiteLLM/dropdown).",
        )
        TEMPERATURE: float = Field(default=0.7, description="Temperature cho cả 2 model.")
        TIMEOUT_SEC: float = Field(default=60.0, description="Timeout per model call.")

    def __init__(self):
        self.valves = self.Valves()
        self.type = "manifold"

    def pipes(self) -> list[dict[str, str]]:
        # Đăng ký 1 model ảo "blind" trong dropdown.
        return [{"id": "blind", "name": "Arena Blind"}]

    async def pipe(
        self,
        body: dict[str, Any],
        __user__: dict[str, Any] | None = None,
        __request__: Any = None,
        **kwargs,
    ) -> str:
        pool = [m.strip() for m in self.valves.MODEL_POOL.split(",") if m.strip()]
        if len(pool) < 2:
            return "⚠️ Arena Blind cần ≥ 2 model trong MODEL_POOL. Config qua Admin → Functions → Arena Blind → ⚙️."

        model_a, model_b = random.sample(pool, 2)
        arena_key = uuid.uuid4().hex[:12]
        messages = body.get("messages", [])

        req_a = {"model": model_a, "messages": messages, "stream": False,
                 "temperature": self.valves.TEMPERATURE}
        req_b = {"model": model_b, "messages": messages, "stream": False,
                 "temperature": self.valves.TEMPERATURE}

        try:
            from open_webui.utils.chat import generate_chat_completion
        except ImportError:
            return "⚠️ Không import được `open_webui.utils.chat.generate_chat_completion`. Check OpenWebUI version."

        async def _call(req: dict) -> str:
            try:
                resp = await asyncio.wait_for(
                    generate_chat_completion(__request__, req, user=__user__),
                    timeout=self.valves.TIMEOUT_SEC,
                )
                return resp["choices"][0]["message"]["content"]
            except asyncio.TimeoutError:
                return f"_[timeout > {self.valves.TIMEOUT_SEC}s]_"
            except Exception as e:  # noqa: BLE001
                return f"_[error: {type(e).__name__}: {str(e)[:120]}]_"

        text_a, text_b = await asyncio.gather(_call(req_a), _call(req_b))

        # Log pair record (dùng cho action vote lookup).
        pair_record = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "event": "pair",
            "arena_key": arena_key,
            "user": (__user__ or {}).get("email") or (__user__ or {}).get("id") or "anon",
            "chat_id": body.get("chat_id") or body.get("metadata", {}).get("chat_id"),
            "model_a": model_a,
            "model_b": model_b,
        }
        try:
            VOTES_PATH.parent.mkdir(parents=True, exist_ok=True)
            with VOTES_PATH.open("a", encoding="utf-8") as f:
                f.write(json.dumps(pair_record, ensure_ascii=False) + "\n")
        except OSError as e:
            return f"⚠️ Không ghi được {VOTES_PATH}: {e}"

        return (
            f"**🅰️ Response A**\n\n{text_a}\n\n"
            f"---\n\n"
            f"**🅱️ Response B**\n\n{text_b}\n\n"
            f"---\n\n"
            f"_Blind arena — bấm 1 button vote dưới đây để reveal + ghi log._\n\n"
            f"<!-- arena_key={arena_key} -->"
        )
