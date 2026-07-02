"""Env-driven settings — single source of truth for runtime knobs."""
from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # FastAPI
    host: str = "0.0.0.0"
    port: int = 8080
    log_level: str = "INFO"

    # LLM — provider-agnostic via LiteLLM. Set `llm_model` to `<provider>/<model>`,
    # e.g. `anthropic/claude-sonnet-4-5`, `gemini/gemini-2.5-flash`,
    # `openai/gpt-4.1-mini`, `deepseek/deepseek-chat`.
    llm_model: str = "anthropic/claude-sonnet-4-5"
    llm_max_tokens: int = 2048
    # Comma-separated fallback list. If primary model fails (timeout/5xx/malformed),
    # LiteLLM retries against these in order. Empty = no fallback.
    llm_fallback_models: str = ""
    # [V7] Anthropic prompt caching — cuts cost ~65% for repeated system prompt +
    # tool schema. Auto-applied only when `llm_model` starts with `anthropic/`.
    llm_enable_prompt_cache: bool = True
    # LLM_MOCK=true → in-process canned response, no API call. Useful before key
    # is provisioned and for deterministic tests.
    llm_mock: bool = False
    # Corp proxy support — LiteLLM reads HTTPS_PROXY env var natively; no code
    # change needed here beyond exposing the setting.
    https_proxy: str = ""

    # Provider API keys — LiteLLM reads matching env vars directly. Fields exist
    # so pydantic doesn't reject them from .env; values are re-exported to env
    # in llm_client._configure_env() so LiteLLM can pick them up.
    anthropic_api_key: str = ""
    gemini_api_key: str = ""
    deepseek_api_key: str = ""

    # Back-compat shims: old env vars still honored so existing .env files keep
    # working. If set, they override llm_model / llm_max_tokens on init.
    anthropic_model: str = ""
    anthropic_max_tokens: int = 0

    # Embeddings (for query → Qdrant search)
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    embed_model: str = "text-embedding-3-small"
    embed_mock: bool = False

    # Qdrant
    qdrant_url: str = "http://qdrant:6333"
    qdrant_api_key: str = ""
    qdrant_collection: str = "log_templates"

    # VictoriaLogs
    vl_url: str = "http://victorialogs:9428"
    vl_query_limit: int = 200

    # Agent loop
    agent_max_turns: int = 5
    agent_timeout_s: int = 30

    # Telegram alert push (Phase 06)
    telegram_bot_token: str = ""
    telegram_alert_chat_id: str = ""
    # TELEGRAM_MOCK=true → log message instead of HTTP push. For dry-run /
    # tests / when bot not yet provisioned.
    telegram_mock: bool = False

    # Alert dedupe — same fingerprint won't re-push within this window.
    alert_dedupe_ttl_s: int = 3600


settings = Settings()
