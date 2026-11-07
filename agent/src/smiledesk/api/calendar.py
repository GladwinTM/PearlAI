from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query

from smiledesk.config import get_settings
from smiledesk.db import get_db, rows

router = APIRouter()


@router.get("/api/calendar")
async def calendar(
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: Annotated[date | None, Query()] = None,
) -> dict[str, Any]:
    """Masked appointments for the public calendar. Defaults to the current clinic week (Mon–Sat)."""
    s = get_settings()
    today = datetime.now(ZoneInfo(s.clinic_timezone)).date()
    start = from_ or (today - timedelta(days=today.weekday()))
    end = to or (start + timedelta(days=6))
    if end < start:
        raise HTTPException(400, "`to` must be on or after `from`.")
    if (end - start).days > 31:
        raise HTTPException(400, "Range can be at most 31 days.")

    def _q() -> list[dict[str, Any]]:
        res = get_db().rpc("get_calendar", {"p_from": start.isoformat(), "p_to": end.isoformat()}).execute()
        return rows(res)

    def _dentists() -> list[dict[str, Any]]:
        res = (
            get_db()
            .table("dentists")
            .select("id, full_name, specialty")
            .eq("is_active", True)
            .order("full_name")
            .execute()
        )
        return rows(res)

    appts, dentists = await asyncio.gather(asyncio.to_thread(_q), asyncio.to_thread(_dentists))
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "timezone": s.clinic_timezone,
        "dentists": dentists,
        "appointments": appts,
    }
