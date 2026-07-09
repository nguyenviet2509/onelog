"""
LiteLLM proxy custom callback — 2 responsibilities:

1. **Validate every completion** before returning to client. If a provider
   returns HTTP 200 with an empty or malformed body, LiteLLM's default
   router treats it as success and does NOT fall back. Users then get a
   blank answer and still get billed. Raise so router escalates to next
   fallback (phase-02 [RT-F10]).

2. **Emit cost record** as structured JSON to stdout on every successful
   completion. LiteLLM's built-in access log doesn't include cost/tokens
   — but they arrive in `kwargs` as `standard_logging_object` or via
   `kwargs["response_cost"]`. We flatten them into a JSON line that
   Vector reads via docker_logs source and forwards to VictoriaLogs.
   Field names match Grafana dashboard queries (see phase-02 spec).

Registered via `litellm_settings.callbacks: custom_callbacks.proxy_handler_instance`
in config.yaml. Module lives at /app/callbacks (mounted from
infra/litellm/callbacks/). Python sys.path includes /app in official image.
"""
from __future__ import annotations

import json
import sys

from litellm.integrations.custom_logger import CustomLogger

# Debug beacon at module import time — confirms the file is actually loaded
# by LiteLLM's Python interpreter. Grep container logs for this line during
# first-boot troubleshooting: `docker compose logs litellm-proxy | grep BEACON`.
print(json.dumps({"event": "onelog_callback_module_loaded", "file": __file__}), flush=True)


def _emit_cost_record(kwargs: dict, response_obj, start_time, end_time) -> None:
    """Emit 1 JSON line to stdout with cost/token/user metadata for VL ingest.

    Never raises — logging failure must not break request flow.
    """
    try:
        # Prefer standard_logging_object (LiteLLM canonical) if present.
        slo = kwargs.get("standard_logging_object") or {}
        metadata = kwargs.get("litellm_params", {}).get("metadata", {}) or {}
        usage = getattr(response_obj, "usage", None)

        def _u(field: str, default: int = 0) -> int:
            if usage is None:
                return default
            val = getattr(usage, field, None)
            if val is None and isinstance(usage, dict):
                val = usage.get(field, default)
            return int(val) if val is not None else default

        duration_ms = 0
        if start_time and end_time:
            try:
                duration_ms = int((end_time - start_time).total_seconds() * 1000)
            except Exception:
                duration_ms = 0

        record = {
            "event": "litellm_cost",
            "model": slo.get("model") or kwargs.get("model") or "",
            "response_cost": float(
                slo.get("response_cost") or kwargs.get("response_cost") or 0.0
            ),
            "user_api_key_alias": (
                metadata.get("user_api_key_alias")
                or slo.get("metadata", {}).get("user_api_key_alias")
                or kwargs.get("user")
                or "unknown"
            ),
            "prompt_tokens": _u("prompt_tokens"),
            "completion_tokens": _u("completion_tokens"),
            "total_tokens": _u("total_tokens"),
            "cache_read_input_tokens": _u("cache_read_input_tokens"),
            "duration_ms": duration_ms,
            # Router fallback signal — populated when this call is a retry
            # after primary failure. Enables `fallback:true` filter in vmalert.
            "fallback": bool(kwargs.get("litellm_params", {}).get("fallback_model_group")),
        }
        # Print with flush so Docker log driver captures immediately.
        print(json.dumps(record), flush=True)
    except Exception as exc:  # pragma: no cover — defensive
        # Emit a warning line but never break request path.
        print(
            json.dumps({"event": "litellm_cost_emit_error", "error": str(exc)}),
            flush=True,
            file=sys.stderr,
        )


def _validate_completion(response_obj) -> None:
    """Raise if completion is empty (no content and no tool_calls)."""
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


class OnelogValidateHandler(CustomLogger):
    """Validate completions + emit cost record on success."""

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        print(json.dumps({"event": "onelog_callback_fired", "path": "async_log_success"}), flush=True)
        _validate_completion(response_obj)
        _emit_cost_record(kwargs, response_obj, start_time, end_time)

    # Sync path for older LiteLLM code paths — same rule.
    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        print(json.dumps({"event": "onelog_callback_fired", "path": "sync_log_success"}), flush=True)
        _validate_completion(response_obj)
        _emit_cost_record(kwargs, response_obj, start_time, end_time)


proxy_handler_instance = OnelogValidateHandler()
