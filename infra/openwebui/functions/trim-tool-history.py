"""
title: Trim Tool History
author: onelog
version: 0.2.0
description: Truncate old tool-call outputs + emit UX warnings when chat approaches context limits. Root fix for incident 2026-08-22 (chat hit 2M tokens, exceeded DeepSeek 1M limit).
"""

# Function OpenWebUI · plan follow-up 260822-1007-openwebui-context-optimization.
# Inlet filter: modify body.messages BEFORE sending to LLM backend (LiteLLM).
#
# Strategy 2 lớp:
#   Layer A — Truncate tool outputs cũ:
#     1. Preserve last KEEP_LAST_N_TURNS user turn + reply (default 1).
#     2. Tool role msg cũ > MAX_TOOL_OUTPUT_CHARS → middle-cut (giữ đầu+cuối).
#     3. Tổng chars vượt MAX_TOTAL_CHARS → drop oldest tool msg cũ.
#
#   Layer B — UX Warning banner:
#     4. Estimate total tokens ≈ chars / 4 (heuristic conservative cho VN + JSON).
#     5. > SOFT_WARN_TOKENS (100k) → emit notification "Chat lớn, cân nhắc fork".
#     6. > HARD_WARN_TOKENS (180k) → emit notification "SẮP HIT limit, fork ngay".
#     7. Track state qua msg count để tránh spam mỗi turn (chỉ emit khi cross threshold).
#
# KHÔNG lưu state persistent — pure function trên body mỗi request. Idempotent.

from typing import Any, Awaitable, Callable, Optional

from pydantic import BaseModel, Field


class Filter:
    class Valves(BaseModel):
        MAX_TOOL_OUTPUT_CHARS: int = Field(
            default=8000,
            description="Max chars/tool response trong history cũ (giữ đầu+cuối, cắt giữa). "
            "8000 ~= 2000 tokens, đủ để LLM nhớ shape của tool result.",
        )
        KEEP_LAST_N_TURNS: int = Field(
            default=1,
            description="Số user turn cuối được giữ nguyên (không truncate). "
            "1 = current turn only, previous turns bị truncate.",
        )
        MAX_TOTAL_CHARS: int = Field(
            default=600_000,
            description="Hard cap tổng chars của body.messages (~150k tokens). "
            "Vượt = drop oldest tool messages. DeepSeek 1M tokens ≈ 4M chars, "
            "cap 600k chars = 150k tokens = buffer an toàn.",
        )
        SOFT_WARN_TOKENS: int = Field(
            default=100_000,
            description="Ngưỡng cảnh báo mềm (tokens estimate). Emit toast yellow. "
            "100k ~= 400k chars ~= 10% ceiling DeepSeek 1M.",
        )
        HARD_WARN_TOKENS: int = Field(
            default=180_000,
            description="Ngưỡng cảnh báo cứng (tokens estimate). Emit toast red khuyên fork chat. "
            "180k ~= 720k chars ~= 18% ceiling DeepSeek 1M. Cấp thứ 2 dưới MAX_TOTAL_CHARS.",
        )
        CHARS_PER_TOKEN: float = Field(
            default=4.0,
            description="Heuristic chars/token cho tiếng Việt + JSON tool output. "
            "Google/OpenAI tokenizer ≈ 3-4, DeepSeek ≈ 3-4 cho VN. Dùng 4 conservative.",
        )
        TRUNCATE_MARKER: str = Field(
            default="\n\n... [truncated by trim-tool-history filter, {removed} chars] ...\n\n",
            description="Marker chèn vào giữa tool output khi truncate.",
        )
        DEBUG: bool = Field(
            default=False,
            description="Print debug info về mỗi lần filter chạy (kiểm openwebui logs).",
        )

    def __init__(self) -> None:
        self.valves = self.Valves()

    # ---- helpers ----
    def _truncate_middle(self, text: str, max_chars: int) -> str:
        if len(text) <= max_chars:
            return text
        head = max_chars // 2
        tail = max_chars - head
        removed = len(text) - max_chars + len(self.valves.TRUNCATE_MARKER)
        marker = self.valves.TRUNCATE_MARKER.format(removed=removed)
        return text[:head] + marker + text[-tail:]

    def _count_user_turns(self, messages: list[dict]) -> int:
        return sum(1 for m in messages if m.get("role") == "user")

    def _content_chars(self, msg: dict) -> int:
        c = msg.get("content")
        if isinstance(c, str):
            return len(c)
        if isinstance(c, list):
            return sum(
                len(part.get("text", "")) if isinstance(part, dict) else len(str(part))
                for part in c
            )
        return len(str(c)) if c else 0

    def _total_chars(self, messages: list[dict]) -> int:
        return sum(self._content_chars(m) for m in messages)

    def _estimate_tokens(self, chars: int) -> int:
        return int(chars / self.valves.CHARS_PER_TOKEN)

    # ---- main inlet ----
    async def inlet(
        self,
        body: dict,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[Callable[[dict], Awaitable[None]]] = None,
    ) -> dict:
        messages = body.get("messages", [])
        if not messages:
            return body

        before_chars = self._total_chars(messages)
        total_user_turns = self._count_user_turns(messages)
        keep_from_turn = max(0, total_user_turns - self.valves.KEEP_LAST_N_TURNS)

        # Layer A: Truncate tool outputs in old turns
        current_user_turn = 0
        truncated_count = 0
        for msg in messages:
            if msg.get("role") == "user":
                current_user_turn += 1
                continue
            if current_user_turn < keep_from_turn and msg.get("role") == "tool":
                content = msg.get("content")
                if isinstance(content, str) and len(content) > self.valves.MAX_TOOL_OUTPUT_CHARS:
                    msg["content"] = self._truncate_middle(content, self.valves.MAX_TOOL_OUTPUT_CHARS)
                    truncated_count += 1

        # Hard cap: drop oldest tool msgs in old turns until under MAX_TOTAL_CHARS
        dropped_count = 0
        if self._total_chars(messages) > self.valves.MAX_TOTAL_CHARS:
            kept: list[dict] = []
            current_user_turn = 0
            for msg in messages:
                if msg.get("role") == "user":
                    current_user_turn += 1
                if (
                    msg.get("role") == "tool"
                    and current_user_turn < keep_from_turn
                    and self._total_chars(kept) + self._content_chars(msg) > self.valves.MAX_TOTAL_CHARS
                ):
                    dropped_count += 1
                    continue
                kept.append(msg)
            messages = kept
            body["messages"] = messages

        after_chars = self._total_chars(messages)
        after_tokens = self._estimate_tokens(after_chars)

        # Layer B: UX warning via event_emitter
        if __event_emitter__ is not None:
            if after_tokens > self.valves.HARD_WARN_TOKENS:
                await __event_emitter__(
                    {
                        "type": "notification",
                        "data": {
                            "type": "warning",
                            "content": (
                                f"🚨 Chat rất lớn (~{after_tokens // 1000}k tokens, ceiling DeepSeek 1M). "
                                f"KHUYẾN NGHỊ: tạo new chat cho câu hỏi khác để tránh crash context."
                            ),
                        },
                    }
                )
            elif after_tokens > self.valves.SOFT_WARN_TOKENS:
                await __event_emitter__(
                    {
                        "type": "notification",
                        "data": {
                            "type": "info",
                            "content": (
                                f"⚠️ Chat đang lớn (~{after_tokens // 1000}k tokens). "
                                f"Cân nhắc tạo new chat nếu câu hỏi tiếp không liên quan turn cũ."
                            ),
                        },
                    }
                )

        if self.valves.DEBUG or (before_chars - after_chars) > 50_000:
            # flush=True vì uvicorn buffer stdout, print thường không hiện trong
            # docker logs cho tới khi container flush. file=sys.stderr càng chắc
            # (stderr unbuffered by default in Python).
            import sys

            print(
                f"[trim-tool-history] turns={total_user_turns} "
                f"before={before_chars:,}ch after={after_chars:,}ch "
                f"tokens_est={after_tokens:,} "
                f"truncated={truncated_count} dropped={dropped_count}",
                file=sys.stderr,
                flush=True,
            )

        return body

    async def outlet(
        self,
        body: dict,
        __user__: Optional[dict] = None,
    ) -> dict:
        # Không đụng response — chỉ inlet quan trọng cho context bloat.
        return body
