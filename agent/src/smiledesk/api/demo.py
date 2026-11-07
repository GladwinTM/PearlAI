from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from smiledesk.config import get_settings
from smiledesk.db import get_db, row
from smiledesk.ratelimit import rate_limit

router = APIRouter()


def reset_demo_fixtures() -> dict[str, Any]:
    """Shared by the API and (from M5) the eval runner before every case."""
    return row(get_db().rpc("reset_demo_fixtures", {}).execute())


@router.post("/api/demo/reset", dependencies=[Depends(rate_limit)])
async def demo_reset() -> dict[str, Any]:
    if not get_settings().demo_mode:
        raise HTTPException(404, "Not found")
    return {"ok": True, **(await asyncio.to_thread(reset_demo_fixtures))}
