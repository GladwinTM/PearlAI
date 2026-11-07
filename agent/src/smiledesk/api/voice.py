"""WebRTC signalling for browser voice (SmallWebRTC): POST /api/offer (SDP) and PATCH /api/offer (ICE)."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from loguru import logger
from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)

from smiledesk.agent.personas import PERSONAS
from smiledesk.clock import now
from smiledesk.config import get_settings
from smiledesk.ratelimit import rate_limit
from smiledesk.voice.pipeline import active_sessions, run_voice_session

router = APIRouter()
_tasks: set[asyncio.Task[None]] = set()
# Calls started per clinic day (in memory: a restart resets it, which is fine for a quota guard).
_calls_by_day: dict[str, int] = {}
RESTING = "Pearl is resting for today: the demo's daily voice limit is reached. Chat still works, so give that a try!"


def calls_today() -> int:
    return _calls_by_day.get(now().date().isoformat(), 0)


def daily_limit_reached() -> bool:
    cap = get_settings().max_voice_calls_per_day
    return bool(cap) and calls_today() >= cap


_handler: SmallWebRTCRequestHandler | None = None


def ice_servers() -> list[dict[str, Any]]:
    raw = get_settings().ice_servers_json.strip()
    return json.loads(raw) if raw else []


def handler() -> SmallWebRTCRequestHandler:
    global _handler
    if _handler is None:
        servers = [IceServer(**x) for x in ice_servers()]
        _handler = SmallWebRTCRequestHandler(ice_servers=servers or None)
    return _handler


@router.get("/api/voice/config")
async def voice_config() -> dict[str, Any]:
    s = get_settings()
    return {
        "transport": s.voice_transport,
        "ice_servers": ice_servers(),
        "max_session_seconds": s.max_voice_session_seconds,
        "active_sessions": len(active_sessions),
        "max_sessions": s.max_voice_sessions,
        "daily_limit_reached": daily_limit_reached(),
        "resting_message": RESTING,
    }


@router.post("/api/offer", dependencies=[Depends(rate_limit)])
async def offer(raw: Request) -> dict[str, Any]:
    # Parse by hand: the JS client sends `requestData` (camelCase), which only from_dict understands.
    try:
        request = SmallWebRTCRequest.from_dict(await raw.json())
    except (ValueError, TypeError) as e:
        raise HTTPException(400, f"Invalid WebRTC offer: {e}") from e
    s = get_settings()
    if s.voice_transport != "smallwebrtc":
        raise HTTPException(400, f"VOICE_TRANSPORT={s.voice_transport} doesn't use /api/offer.")
    is_new_call = not request.pc_id
    if is_new_call and daily_limit_reached():
        raise HTTPException(429, RESTING)
    if is_new_call and len(active_sessions) >= s.max_voice_sessions:
        raise HTTPException(429, "Pearl is on another call right now. Please try again in a minute, or use chat.")
    body = request.request_data if isinstance(request.request_data, dict) else {}
    persona = body.get("persona") if s.demo_mode else None
    if persona and persona not in PERSONAS:
        raise HTTPException(400, f"Unknown persona '{persona}'.")
    conversation_id = body.get("conversation_id")
    if conversation_id is not None:
        try:
            conversation_id = str(uuid.UUID(str(conversation_id)))
        except ValueError as e:
            raise HTTPException(400, "Invalid conversation_id.") from e

    if is_new_call:
        day = now().date().isoformat()
        if day not in _calls_by_day:
            _calls_by_day.clear()  # keep only today's count
        _calls_by_day[day] = _calls_by_day.get(day, 0) + 1

    async def on_connection(connection: SmallWebRTCConnection) -> None:
        task = asyncio.create_task(run_voice_session(connection, persona, conversation_id))
        _tasks.add(task)

        def _done(t: asyncio.Task[None]) -> None:
            _tasks.discard(t)
            if not t.cancelled() and t.exception():
                logger.opt(exception=t.exception()).error("voice session crashed")

        task.add_done_callback(_done)

    answer = await handler().handle_web_request(request=request, webrtc_connection_callback=on_connection)
    if answer is None:
        raise HTTPException(500, "No SDP answer")
    return dict(answer)


@router.patch("/api/offer")
async def ice_candidate(request: SmallWebRTCPatchRequest) -> dict[str, str]:
    await handler().handle_patch_request(request)
    return {"status": "success"}


async def shutdown() -> None:
    if _handler is not None:
        await _handler.close()
    for t in list(_tasks):
        t.cancel()
