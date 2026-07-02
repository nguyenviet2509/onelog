"""
LiteLLM proxy custom callback — validate every completion before returning
to client. If a provider returns HTTP 200 with an empty or malformed body,
LiteLLM's default router treats it as success and does NOT fall back. Users
then get a blank answer and still get billed.

This handler raises on such responses so the router escalates to the next
fallback in the chain. See phase-02 [RT-F10].

Registered via `litellm_settings.callbacks: custom_callbacks.proxy_handler_instance`
in config.yaml. The module lives at /app/callbacks (mounted from
infra/litellm/callbacks/) and Python sys.path includes /app in the official
image.
"""
from __future__ import annotations

from litellm.integrations.custom_logger import CustomLogger


class OnelogValidateHandler(CustomLogger):
    """Reject empty completions so the router triggers fallback."""

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        choices = getattr(response_obj, "choices", None) or []
        if not choices:
            raise ValueError("empty response: no choices — trigger fallback")

        msg = getattr(choices[0], "message", None)
        content = getattr(msg, "content", None) if msg else None
        tool_calls = getattr(msg, "tool_calls", None) if msg else None

        # A completion is "empty" only when it has neither text nor tool calls.
        # Some providers legitimately return content=None when only tool_calls
        # are present (Anthropic tool-use turn) — that MUST be treated valid.
        if not content and not tool_calls:
            raise ValueError("empty response: no content and no tool_calls")

    # Sync path for older LiteLLM code paths — same rule.
    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        choices = getattr(response_obj, "choices", None) or []
        if not choices:
            raise ValueError("empty response: no choices — trigger fallback")
        msg = getattr(choices[0], "message", None)
        content = getattr(msg, "content", None) if msg else None
        tool_calls = getattr(msg, "tool_calls", None) if msg else None
        if not content and not tool_calls:
            raise ValueError("empty response: no content and no tool_calls")


proxy_handler_instance = OnelogValidateHandler()
