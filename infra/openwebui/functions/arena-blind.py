"""
title: Arena Blind
author: onelog
version: 0.2.1
description: Blind A/B compare 2 random models qua LiteLLM. Vote qua 4 action buttons riêng (arena-vote-*).
requirements: httpx
"""

# Pipe OpenWebUI · plan 260728-0829-openwebui-blind-arena
# User chọn "Arena Blind" từ model dropdown → prompt gửi song song tới 2 model
# random từ POOL qua LiteLLM HTTP. Response gộp thành 1 message, ẩn tên model.
# arena_key (UUID) nhúng trong HTML comment cuối message → action vote lookup
# pair từ arena-votes.jsonl để append vote record + reveal.
#
# v0.2.0 (28/07/2026): bỏ open_webui.utils.chat.generate_chat_completion (ăn
# "Model not found" vì MODELS dict lookup không thấy alias LiteLLM). Chuyển
# sang gọi thẳng LiteLLM /v1/chat/completions.

import asyncio
import json
import random
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, Field

VOTES_PATH = Path("/app/backend/data/arena-votes.jsonl")


class Pipe:
    class Valves(BaseModel):
        LITELLM_URL: str = Field(
            default="http://litellm-proxy:4000/v1",
            description="Base URL LiteLLM (không kèm /chat/completions).",
        )
        LITELLM_API_KEY: str = Field(
            default="",
            description="Virtual key / master key LiteLLM. Lấy từ OPENWEBUI_LITELLM_VIRTUAL_KEY trong .env.",
        )
        MODEL_POOL: str = Field(
            default="claude-sonnet,deepseek,gemini-flash,gpt-4-mini",
            description="Comma-separated model IDs (khớp model_name trong LiteLLM config.yaml).",
        )
        TEMPERATURE: float = Field(default=0.7, description="Temperature cho cả 2 model.")
        TIMEOUT_SEC: float = Field(default=60.0, description="Timeout per model call.")

    def __init__(self):
        self.valves = self.Valves()
        self.type = "manifold"

    def pipes(self) -> list[dict[str, str]]:
        return [{"id": "blind", "name": "Arena Blind"}]

    async def pipe(
        self,
        body: dict[str, Any],
        __user__: dict[str, Any] | None = None,
        **kwargs,
    ) -> str:
        pool = [m.strip() for m in self.valves.MODEL_POOL.split(",") if m.strip()]
        if len(pool) < 2:
            return "⚠️ Arena Blind cần ≥ 2 model trong MODEL_POOL. Config qua Admin → Functions → Arena Blind → ⚙️."
        if not self.valves.LITELLM_API_KEY:
            return "⚠️ Chưa set LITELLM_API_KEY trong Valves. Admin → Functions → Arena Blind → ⚙️."

        model_a, model_b = random.sample(pool, 2)
        arena_key = uuid.uuid4().hex[:12]

        # Lọc messages: CHỈ giữ role="user"/"assistant" với content string.
        # Bỏ tool/function messages + tool_calls từ assistant vì blind arena
        # gọi lại từ đầu, không có tool binding → LiteLLM/Anthropic reject
        # "Missing corresponding tool call".
        raw_messages = body.get("messages", [])
        messages: list[dict[str, str]] = []
        for m in raw_messages:
            role = m.get("role")
            content = m.get("content")
            if role not in ("user", "assistant"):
                continue
            if not isinstance(content, str) or not content.strip():
                continue
            messages.append({"role": role, "content": content})

        url = f"{self.valves.LITELLM_URL.rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.valves.LITELLM_API_KEY}",
            "Content-Type": "application/json",
        }

        async def _call(model: str) -> str:
            payload = {"model": model, "messages": messages, "stream": False,
                       "temperature": self.valves.TEMPERATURE}
            try:
                async with httpx.AsyncClient(timeout=self.valves.TIMEOUT_SEC) as client:
                    r = await client.post(url, json=payload, headers=headers)
                    r.raise_for_status()
                    data = r.json()
                    return data["choices"][0]["message"]["content"]
            except httpx.TimeoutException:
                return f"_[timeout > {self.valves.TIMEOUT_SEC}s]_"
            except httpx.HTTPStatusError as e:
                return f"_[HTTP {e.response.status_code}: {e.response.text[:200]}]_"
            except Exception as e:  # noqa: BLE001
                return f"_[error {type(e).__name__}: {str(e)[:150]}]_"

        text_a, text_b = await asyncio.gather(_call(model_a), _call(model_b))

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
