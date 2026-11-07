"""POST /api/chat → Server-Sent Events stream of agent core events."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from loguru import logger
from pydantic import BaseModel, Field

from smiledesk.agent.core import run_turn, store
from smiledesk.agent.personas import PERSONAS
from smiledesk.config import get_settings
from smiledesk.ratelimit import rate_limit

router = APIRouter()


class ChatRequest(BaseModel):
    conversation_id: str | None = None
    persona: str | None = None
    message: str = Field(min_length=1, max_length=2000)


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


@router.get("/api/personas")
async def personas() -> dict[str, Any]:
    if not get_settings().demo_mode:
        return {"personas": []}
    return {"personas": [{"id": p.id, "label": p.label, "description": p.description} for p in PERSONAS.values()]}


@router.post("/api/chat", dependencies=[Depends(rate_limit)])
async def chat(req: ChatRequest) -> StreamingResponse:
    persona = req.persona if get_settings().demo_mode else None
    if persona and persona not in PERSONAS:
        raise HTTPException(400, f"Unknown persona '{persona}'.")
    conv = await store.get_or_create(req.conversation_id, persona=persona, channel="chat")
    if persona and not conv.persona:
        conv.persona = persona

    async def events() -> AsyncIterator[str]:
        yield sse(
            "conversation", {"conversation_id": conv.id, "persona": conv.persona, "prompt_version": conv.prompt_version}
        )
        try:
            async for ev in run_turn(conv, req.message.strip()):
                yield sse(ev["type"], ev)
        except Exception:
            logger.exception("chat turn crashed")
            yield sse("error", {"type": "error", "message": "Something went wrong on our side. Please try again."})
            yield sse("done", {"type": "done", "text": "", "outcome": None, "timings": {}})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
