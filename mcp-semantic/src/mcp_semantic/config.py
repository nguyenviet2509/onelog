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
    # Static bearer for MVP — set MCP_BEARER in env; clients send it as
    # `Authorization: Bearer ...`. Empty disables auth (lab only, Caddy IP
    # whitelist must guard).
    mcp_bearer: str = ""

    log_level: str = "INFO"


settings = Settings()
