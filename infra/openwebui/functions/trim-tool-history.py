"""
title: Trim Tool History
author: onelog
version: 0.1.0
description: Truncate old tool-call outputs in message history to prevent context bloat when chatting continues in same session. Root fix for incident 2026-08-22 09:30 (chat hit 2M tokens, exceeded DeepSeek 1M limit).
"""

# Function OpenWebUI · plan follow-up 260822-0932-openwebui-context-bloat.
# Inlet filter: modify body.messages BEFORE sending to LLM backend (LiteLLM).
# Strategy:
#   1. Preserve current user turn + assistant reply pair (last 2 messages) untouched.
#   2. For older 'tool' role messages: truncate content to MAX_TOOL_OUTPUT_CHARS,
#      keep first N + last M chars + marker (giữ context recognizable, cắt bulk log).
#   3. For older 'assistant' messages có tool_calls output đính kèm: skip (không đụng
#      vì đó là history quan trọng cho reasoning chain).
#   4. Nếu tổng char sau bước 1-3 vẫn > MAX_TOTAL_CHARS: drop oldest tool messages
#      (older than KEEP_LAST_N_TURNS user turns) hoàn toàn.
#
# KHÔNG lưu state — pure function trên body mỗi request. Idempotent.

from typing import Any, Optional

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
        TRUNCATE_MARKER: str = Field(
            default="\n\n... [truncated by trim-tool-history filter, {removed} chars] ...\n\n",
            description="Marker chèn vào giữa tool output khi truncate.",
        )
        DEBUG: bool = Field(
            default=False, description="Print debug info về mỗi lần filter chạy (kiểm openwebui logs)."
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
            return sum(len(part.get("text", "")) if isinstance(part, dict) else len(str(part)) for part in c)
        return len(str(c)) if c else 0

    def _total_chars(self, messages: list[dict]) -> int:
        return sum(self._content_chars(m) for m in messages)

    # ---- main inlet ----
    def inlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        messages = body.get("messages", [])
        if not messages:
            return body

        before_chars = self._total_chars(messages)
        total_user_turns = self._count_user_turns(messages)
        keep_from_turn = max(0, total_user_turns - self.valves.KEEP_LAST_N_TURNS)

        # Walk messages, count user turns as we go; truncate tool outputs
        # that belong to turns older than keep_from_turn.
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

        # Hard cap: if still over MAX_TOTAL_CHARS, drop oldest tool messages
        # (in turns < keep_from_turn) until under cap.
        dropped_count = 0
        if self._total_chars(messages) > self.valves.MAX_TOTAL_CHARS:
            new_messages = []
            current_user_turn = 0
            for msg in messages:
                if msg.get("role") == "user":
                    current_user_turn += 1
                # Drop tool msgs in old turns
                if (
                    msg.get("role") == "tool"
                    and current_user_turn < keep_from_turn
                    and self._total_chars(new_messages + messages[len(new_messages):]) > self.valves.MAX_TOTAL_CHARS
                ):
                    dropped_count += 1
                    continue
                new_messages.append(msg)
                if self._total_chars(new_messages) + sum(
                    self._content_chars(m) for m in messages[len(new_messages):]
                ) <= self.valves.MAX_TOTAL_CHARS:
                    # Once under cap, stop dropping.
                    new_messages.extend(messages[len(new_messages):])
                    break
            messages = new_messages
            body["messages"] = messages

        after_chars = self._total_chars(messages)
        if self.valves.DEBUG or (before_chars - after_chars) > 50_000:
            print(
                f"[trim-tool-history] user_turns={total_user_turns} "
                f"before={before_chars:,}ch after={after_chars:,}ch "
                f"truncated={truncated_count} dropped={dropped_count}"
            )

        return body

    def outlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        # Không đụng response — chỉ inlet quan trọng cho context bloat.
        return body
