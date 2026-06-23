"""FastAPI app — entry point exposed via `onelog-agent` console script."""
from __future__ import annotations

from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware

from agent.auth_stub import attach_user
from agent.config import settings
from agent.routes.alert import router as alert_router
from agent.routes.chat import router as chat_router

app = FastAPI(title="onelog-agent", version="0.1.0")
app.add_middleware(BaseHTTPMiddleware, dispatch=attach_user)
app.include_router(chat_router)
app.include_router(alert_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def run() -> None:
    """Console entry — runs uvicorn server."""
    import uvicorn

    uvicorn.run(
        "agent.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        access_log=False,
    )


if __name__ == "__main__":
    run()
