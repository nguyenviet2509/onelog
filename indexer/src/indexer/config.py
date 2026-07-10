"""Runtime config loaded from env (12-factor). All knobs in one place."""
from __future__ import annotations

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @model_validator(mode="after")
    def _require_embed_key_in_real_mode(self) -> "Settings":
        # Fail-fast: silently switching to mock vectors in prod would poison Qdrant
        # with hash-based embeddings that don't match query-time real embeddings.
        if not self.embed_mock and not self.openai_api_key:
            raise ValueError(
                "OPENAI_API_KEY required when EMBED_MOCK=false. "
                "Set the key or explicitly opt into EMBED_MOCK=true for offline/CI."
            )
        return self

    # NATS JetStream
    nats_url: str = "nats://nats:4222"
    nats_subject: str = "logs.warn"
    nats_stream: str = "LOGS"
    nats_durable: str = "indexer-v1"

    # Qdrant
    qdrant_url: str = "http://qdrant:6333"
    qdrant_api_key: str = ""
    qdrant_collection: str = "log_templates"
    qdrant_vector_size: int = 1536  # text-embedding-3-small

    # Embedding
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    embed_model: str = "text-embedding-3-small"
    embed_mock: bool = False  # set True for offline/CI — deterministic hash-based vectors

    # Batching window — flush after either condition.
    batch_size: int = 500
    batch_window_s: int = 30

    # Drain3
    drain_state_dir: str = "/data/drain_state"
    drain_persist_interval_s: int = 900  # 15 min snapshot

    # Observability
    metrics_port: int = 9100
    log_level: str = "INFO"


settings = Settings()
