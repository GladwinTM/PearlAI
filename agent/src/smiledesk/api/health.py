from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter

from smiledesk.config import get_settings
from smiledesk.warmup import _run, check_database, get_state, running_on

router = APIRouter()


@router.get("/api/health")
async def health() -> dict[str, Any]:
    s = get_settings()
    st = get_state()

    # The DB row is re-checked live on every call (this also keeps a hosted Supabase awake).
    # Model rows report the warmup result; they're expensive to re-probe.
    if st.finished_at is not None:
        await _run("database", check_database, s)

    comps = st.to_dict()
    statuses = {c["status"] for c in comps.values()}
    if "error" in statuses:
        overall = "degraded"
    elif statuses == {"ready"}:
        overall = "ok"
    else:
        overall = "warming"

    ready = sum(1 for c in comps.values() if c["status"] == "ready")
    return {
        "status": overall,
        "running_on": running_on(s),
        "all_local": s.all_local,
        "demo_mode": s.demo_mode,
        "prompt_version": s.prompt_version,
        "voice_transport": s.voice_transport,
        "warmup": {
            "ready": ready,
            "total": len(comps),
            "started_at": st.started_at,
            "finished_at": st.finished_at,
            "elapsed_s": round((st.finished_at or time.time()) - st.started_at, 1) if st.started_at else None,
        },
        "components": comps,
    }
