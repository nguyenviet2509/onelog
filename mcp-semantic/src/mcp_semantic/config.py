"""Env-driven settings — shares schema with indexer/agent for the Qdrant + OpenAI bits."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Qdrant — must match indexer collection/dim.
    qdrant_url: str = "http://qdrant:6333"
    qdrant_api_key: str = ""
    qdrant_collection: str = "log_templates"
    qdrant_vector_size: int = 1536

    # Embedding — same model/mock toggle as agent so semantics align.
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    embed_model: str = "text-embedding-3-small"
    embed_mock: bool = False

    # MCP transport
    host: str = "0.0.0.0"
    port: int = 9000

    # Multi-user Bearer table. Format: "user1:sk-aaa,user2:sk-bbb". Empty +
    # mcp_allow_anon=false = fail-closed (every request denied at /auth/verify).
    mcp_bearer_tokens: str = ""
    # Legacy single-token toggle kept for backward compat — verified after
    # mcp_bearer_tokens. Deprecated, prefer mcp_bearer_tokens.
    mcp_bearer: str = ""
    # Explicit opt-in for anon dev mode. Without this, an empty token table
    # denies every request — production cannot silently fail-open by forgetting
    # MCP_BEARER_TOKENS.
    mcp_allow_anon: bool = False

    # Public base URL for clickable VMUI links emitted in tool responses.
    vmui_base_url: str = "http://app.local"

    # Audit log destination. Container mounts ./data/audit; host owns retention.
    audit_log_path: str = "/var/log/onelog-audit/mcp-semantic.log"

    log_level: str = "INFO"


settings = Settings()
