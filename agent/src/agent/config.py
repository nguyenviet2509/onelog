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

    # LLM (Anthropic)
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-5"
    anthropic_max_tokens: int = 2048
    # LLM_MOCK=true → in-process canned response, no API call. Useful before key
    # is provisioned and for deterministic tests.
    llm_mock: bool = False
    # Corp proxy support — anthropic SDK picks this up via httpx automatically
    # when we hand it a configured client. No code change needed to swap.
    https_proxy: str = ""

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
