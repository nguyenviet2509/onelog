"""Runtime config loaded from env (12-factor). All knobs in one place."""
from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

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
