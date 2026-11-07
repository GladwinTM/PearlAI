"""Conversation + message logging to Postgres. Best-effort: a logging failure never breaks a conversation."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

from loguru import logger

from smiledesk.db import get_db, rows


def create_conversation(channel: str, prompt_version: str, model: str, patient_id: str | None = None) -> str:
    rec = rows(
        get_db()
        .table("conversations")
        .insert({"channel": channel, "prompt_version": prompt_version, "model": model, "patient_id": patient_id})
        .execute()
    )
    return str(rec[0]["id"])


def get_conversation(conversation_id: str) -> dict[str, Any] | None:
    found = rows(get_db().table("conversations").select("*").eq("id", conversation_id).execute())
    return found[0] if found else None


def load_messages(conversation_id: str) -> list[dict[str, Any]]:
    return rows(get_db().table("messages").select("*").eq("conversation_id", conversation_id).order("id").execute())


def _jsonable(v: Any) -> Any:
    if v is None:
        return None
    return json.loads(json.dumps(v, default=str))


def _insert_message(conversation_id: str, payload: dict[str, Any]) -> None:
    get_db().table("messages").insert({"conversation_id": conversation_id, **payload}).execute()


async def log_message(
    conversation_id: str | None,
    role: str,
    content: str | None = None,
    *,
    tool_name: str | None = None,
    tool_args: Any = None,
    tool_result: Any = None,
    latency_ms: int | None = None,
) -> None:
    if not conversation_id:
        return
    payload = {
        "role": role,
        "content": content,
        "tool_name": tool_name,
        "tool_args": _jsonable(tool_args),
        "tool_result": _jsonable(tool_result),
        "latency_ms": latency_ms,
    }
    try:
        await asyncio.to_thread(_insert_message, conversation_id, payload)
    except Exception as e:
        logger.warning(f"message log failed ({role}): {e}")


async def update_conversation(
    conversation_id: str | None,
    *,
    outcome: str | None = None,
    patient_id: str | None = None,
    ended: bool = False,
) -> None:
    if not conversation_id:
        return
    patch: dict[str, Any] = {}
    if outcome:
        patch["outcome"] = outcome
    if patient_id:
        patch["patient_id"] = patient_id
    if ended:
        patch["ended_at"] = datetime.now(UTC).isoformat()
    if not patch:
        return
    try:
        await asyncio.to_thread(
            lambda: get_db().table("conversations").update(patch).eq("id", conversation_id).execute()
        )
    except Exception as e:
        logger.warning(f"conversation update failed: {e}")
