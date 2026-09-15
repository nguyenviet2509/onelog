"""
/chat — Server-Sent Events stream of agent loop events.

Body: {"query": "..."}.
Response: text/event-stream with `data: <json>\\n\\n` per event.
Event types: thinking | tool_call | tool_result | answer | error.

POST chosen over GET so query body is not logged in access logs.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from agent import rbac
from agent.agent_loop import run_agent

router = APIRouter()


class ChatRequest(BaseModel):
    query: str


@router.post(
    "/chat",
    dependencies=[rbac.require("agent:chat.query")],       # no-op if RBAC_ENABLE=false
)
async def chat(req: ChatRequest, request: Request):
    user_sub = getattr(request.state, "user_sub", "anonymous")

    async def event_stream():
        async for ev in run_agent(req.query):
            ev["user_sub"] = user_sub
            yield {"event": ev["type"], "data": json.dumps(ev, default=str)}

    return EventSourceResponse(event_stream())
