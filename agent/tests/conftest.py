"""Shared fixtures. DB tests run against LOCAL Supabase only and restore demo fixtures afterwards."""

from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from supabase import Client

from smiledesk.config import get_settings
from smiledesk.db import rows

# The suite always tests the local stack, whatever the repo's .env points at (e.g. the hosted Supabase + Groq).
# Environment variables beat .env in pydantic-settings, so these win. Set SMILEDESK_TEST_USE_ENV=1 to opt out.
if not os.environ.get("SMILEDESK_TEST_USE_ENV"):
    os.environ.update(
        {
            "SUPABASE_URL": "http://127.0.0.1:54321",
            "SUPABASE_SERVICE_ROLE_KEY": "",  # empty → read from `supabase status`
            "LLM_BASE_URL": "http://localhost:11434/v1",
            "LLM_API_KEY": "ollama",
            "LLM_MODEL": "qwen3:8b",
            "LLM_REASONING_EFFORT": "none",
            "JUDGE_BASE_URL": "http://localhost:11434/v1",
            "JUDGE_API_KEY": "ollama",
            "JUDGE_MODEL": "qwen3:8b",
            "STT_PROVIDER": "local_whisper",
            "STT_MODEL": "small.en",
            "EMBED_PROVIDER": "ollama",
            "EMBED_BASE_URL": "http://localhost:11434/v1",
            "EMBED_MODEL": "nomic-embed-text",
            "ICE_SERVERS_JSON": "",
        }
    )

PRIYA = "11111111-1111-1111-1111-111111111111"
ARJUN = "22222222-2222-2222-2222-222222222222"
KAVYA = "33333333-3333-3333-3333-333333333333"
RAVI = "aaaaaaaa-0000-0000-0000-000000000001"
MEENA = "aaaaaaaa-0000-0000-0000-000000000002"
ANJALI = "aaaaaaaa-0000-0000-0000-000000000003"

TZ = ZoneInfo("Asia/Kolkata")


def today() -> date:
    return datetime.now(TZ).date()


def next_weekday(dow: int) -> date:
    """Next date strictly after today with the given weekday (0 = Sunday … 6 = Saturday, like Postgres)."""
    t = today()
    py_dow = (t.weekday() + 1) % 7  # Python: Monday = 0 → Postgres: Sunday = 0
    return t + timedelta(days=1 + ((dow - py_dow - 1) % 7))


def local(d: date, hhmm: str) -> datetime:
    h, m = map(int, hhmm.split(":"))
    return datetime.combine(d, time(h, m), tzinfo=TZ)


@pytest.fixture(scope="session")
def db() -> Client:
    s = get_settings()
    if "127.0.0.1" not in s.supabase_url and "localhost" not in s.supabase_url:
        pytest.skip("DB tests only run against local Supabase")
    from smiledesk.db import get_db

    try:
        client = get_db()
        client.table("dentists").select("id").limit(1).execute()
    except Exception as e:
        pytest.skip(f"Local Supabase not reachable: {e}")
    return client


@pytest.fixture
def clean_db(db: Client) -> Iterator[Client]:
    """Fresh demo fixtures before and after each test that writes."""
    db.rpc("reset_demo_fixtures", {}).execute()
    yield db
    db.table("time_off").delete().like("reason", "pytest%").execute()
    db.rpc("reset_demo_fixtures", {}).execute()


def slots(db: Client, d: date, appt_type: str, dentist: str | None = None, new: bool = False) -> list[dict[str, Any]]:
    res = db.rpc(
        "get_available_slots",
        {"p_date": d.isoformat(), "p_appointment_type": appt_type, "p_dentist_id": dentist, "p_is_new_patient": new},
    ).execute()
    return rows(res)


def local_times(rows: list[dict[str, Any]]) -> list[str]:
    return [datetime.fromisoformat(r["starts_at"]).astimezone(TZ).strftime("%H:%M") for r in rows]
