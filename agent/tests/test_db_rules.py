"""get_available_slots + booking rules, against local Supabase (seed + reset_demo_fixtures)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from postgrest.exceptions import APIError
from supabase import Client

from smiledesk.db import row, rows
from tests.conftest import (
    ANJALI,
    ARJUN,
    KAVYA,
    MEENA,
    PRIYA,
    RAVI,
    local,
    local_times,
    next_weekday,
    slots,
)

pytestmark = pytest.mark.db

SUN, MON, TUE, WED, THU, FRI, SAT = range(7)


def book(db: Client, patient: str, dentist: str, appt_type: str, starts_at: str, **kw: object) -> dict[str, Any]:
    params = {
        "p_patient_id": patient,
        "p_dentist_id": dentist,
        "p_appointment_type": appt_type,
        "p_starts_at": starts_at,
        "p_source": "chat",
        **kw,
    }
    return row(db.rpc("book_appointment", params).execute())


# ── get_available_slots ─────────────────────────────────────────


def test_closed_on_sunday(clean_db: Client) -> None:
    assert slots(clean_db, next_weekday(SUN), "checkup") == []


def test_thursday_fixture_is_full_for_priya(clean_db: Client) -> None:
    assert slots(clean_db, next_weekday(THU), "checkup", PRIYA) == []
    # Arjun doesn't work Thursdays, so no checkup at all that day.
    assert slots(clean_db, next_weekday(THU), "checkup") == []


def test_root_canal_does_not_fit_60_min_gap(clean_db: Client) -> None:
    mon = next_weekday(MON)
    assert slots(clean_db, mon, "root_canal", ARJUN) == []
    # ...but a 30-min checkup fits the 15:00–16:00 gap.
    assert local_times(slots(clean_db, mon, "checkup", ARJUN)) == ["15:00", "15:15", "15:30"]


def test_root_canal_respects_90_min_duration_and_hours(clean_db: Client) -> None:
    times = local_times(slots(clean_db, next_weekday(WED), "root_canal", ARJUN))
    assert times[0] == "10:00"
    assert times[-1] == "18:30"  # 18:30 + 90 min = 20:00 closing
    # No 90-min slot may overlap lunch (13:00–14:00): last morning start is 11:30, first afternoon 14:00.
    assert "11:30" in times and "11:45" not in times and "12:30" not in times
    assert "14:00" in times


def test_lunch_break_excluded(clean_db: Client) -> None:
    times = local_times(slots(clean_db, next_weekday(TUE), "checkup", PRIYA))
    assert "12:30" in times
    assert not any("12:31" <= t < "14:00" for t in times)
    assert "14:00" in times


def test_new_patient_cutoff_6pm(clean_db: Client) -> None:
    wed = next_weekday(WED)
    existing = local_times(slots(clean_db, wed, "checkup", ARJUN, new=False))
    new = local_times(slots(clean_db, wed, "checkup", ARJUN, new=True))
    assert "19:30" in existing
    assert max(new) < "18:00"
    assert "17:45" in new


def test_service_eligibility_and_schedule(clean_db: Client) -> None:
    # Only Dr. Kavya does braces consults, and only Tue/Thu.
    assert slots(clean_db, next_weekday(WED), "braces_consult") == []
    tue = slots(clean_db, next_weekday(TUE), "braces_consult")
    assert tue and {r["dentist_id"] for r in tue} == {KAVYA}
    # Dr. Priya doesn't do root canals.
    assert slots(clean_db, next_weekday(WED), "root_canal", PRIYA) == []


def test_time_off_blocks_slots(clean_db: Client) -> None:
    fri = next_weekday(FRI)
    assert slots(clean_db, fri, "checkup", PRIYA)
    clean_db.table("time_off").insert(
        {
            "dentist_id": PRIYA,
            "starts_at": local(fri, "00:00").isoformat(),
            "ends_at": local(fri + timedelta(days=1), "00:00").isoformat(),
            "reason": "pytest leave",
        }
    ).execute()
    assert slots(clean_db, fri, "checkup", PRIYA) == []
    assert slots(clean_db, fri, "checkup", ARJUN)  # other dentists unaffected


def test_slots_never_in_the_past(clean_db: Client) -> None:
    from datetime import datetime

    from tests.conftest import TZ, today

    rows = slots(clean_db, today(), "checkup")
    now = datetime.now(TZ)
    assert all(datetime.fromisoformat(r["starts_at"]) > now for r in rows)


# ── book_appointment ────────────────────────────────────────────


def test_book_then_slot_disappears(clean_db: Client) -> None:
    wed = next_weekday(WED)
    start = local(wed, "10:00").isoformat()
    appt = book(clean_db, RAVI, PRIYA, "checkup", start)
    assert appt["status"] == "booked"
    assert appt["ends_at"] and appt["source"] == "chat"
    assert "10:00" not in local_times(slots(clean_db, wed, "checkup", PRIYA))
    # 9:45 checkup would run into 10:00 → also gone
    assert "09:45" not in local_times(slots(clean_db, wed, "checkup", PRIYA))


def test_double_booking_rejected(clean_db: Client) -> None:
    start = local(next_weekday(WED), "11:00").isoformat()
    book(clean_db, RAVI, PRIYA, "checkup", start)
    with pytest.raises(APIError) as e:
        book(clean_db, ANJALI, PRIYA, "checkup", start)
    assert "SLOT_UNAVAILABLE" in str(e.value.message)


def test_patient_cannot_be_in_two_places(clean_db: Client) -> None:
    start = local(next_weekday(WED), "11:00").isoformat()
    book(clean_db, RAVI, PRIYA, "checkup", start)
    with pytest.raises(APIError) as e:
        book(clean_db, RAVI, ARJUN, "checkup", start)
    assert e.value.code == "23P01"  # exclusion constraint no_patient_double_booking


def test_exclusion_constraint_blocks_direct_insert(clean_db: Client) -> None:
    wed = next_weekday(WED)
    book(clean_db, RAVI, PRIYA, "cleaning", local(wed, "15:00").isoformat())  # 15:00–15:45
    with pytest.raises(APIError) as e:
        clean_db.table("appointments").insert(
            {
                "patient_id": ANJALI,
                "dentist_id": PRIYA,
                "appointment_type_id": "checkup",
                "starts_at": local(wed, "15:30").isoformat(),
                "ends_at": local(wed, "16:00").isoformat(),
                "source": "chat",
            }
        ).execute()
    assert e.value.code == "23P01"


def test_cannot_book_off_grid_or_outside_hours(clean_db: Client) -> None:
    wed = next_weekday(WED)
    for hhmm in ("10:05", "08:00", "13:30", "17:45"):  # off-grid, before open, lunch, cleaning past close
        with pytest.raises(APIError) as e:
            book(clean_db, RAVI, PRIYA, "cleaning", local(wed, hhmm).isoformat())
        assert "SLOT_UNAVAILABLE" in str(e.value.message), hhmm


def test_new_patient_cannot_book_after_cutoff(clean_db: Client) -> None:
    wed = next_weekday(WED)
    with pytest.raises(APIError):
        book(clean_db, ANJALI, ARJUN, "checkup", local(wed, "19:00").isoformat())
    # Ravi (has a completed visit) can.
    assert book(clean_db, RAVI, ARJUN, "checkup", local(wed, "19:00").isoformat())["status"] == "booked"


def test_unknown_patient(clean_db: Client) -> None:
    with pytest.raises(APIError) as e:
        book(
            clean_db,
            "aaaaaaaa-0000-0000-0000-00000000dead",
            PRIYA,
            "checkup",
            local(next_weekday(WED), "10:00").isoformat(),
        )
    assert "PATIENT_NOT_FOUND" in str(e.value.message)


def test_family_booking_keeps_booked_by(clean_db: Client) -> None:
    appt = book(clean_db, MEENA, PRIYA, "checkup", local(next_weekday(SAT), "10:00").isoformat(), p_booked_by=RAVI)
    assert appt["patient_id"] == MEENA and appt["booked_by_patient_id"] == RAVI


# ── reschedule_appointment ──────────────────────────────────────


def test_reschedule_moves_booking(clean_db: Client) -> None:
    wed = next_weekday(WED)
    old = book(clean_db, RAVI, PRIYA, "checkup", local(wed, "10:00").isoformat())
    new = row(
        clean_db.rpc(
            "reschedule_appointment",
            {"p_appointment_id": old["id"], "p_new_starts_at": local(wed, "16:00").isoformat()},
        ).execute()
    )
    assert new["rescheduled_from"] == old["id"]
    status = row(clean_db.table("appointments").select("status").eq("id", old["id"]).single().execute())
    assert status["status"] == "rescheduled"
    assert "10:00" in local_times(slots(clean_db, wed, "checkup", PRIYA))  # old slot freed


def test_reschedule_to_unavailable_slot_rolls_back(clean_db: Client) -> None:
    old = book(clean_db, RAVI, PRIYA, "checkup", local(next_weekday(WED), "10:00").isoformat())
    full_thursday = local(next_weekday(THU), "10:00").isoformat()
    with pytest.raises(APIError) as e:
        clean_db.rpc(
            "reschedule_appointment", {"p_appointment_id": old["id"], "p_new_starts_at": full_thursday}
        ).execute()
    assert "SLOT_UNAVAILABLE" in str(e.value.message)
    status = row(clean_db.table("appointments").select("status").eq("id", old["id"]).single().execute())
    assert status["status"] == "booked"


# ── reset_demo_fixtures + calendar ──────────────────────────────


def test_reset_removes_agent_bookings_and_restores_fixtures(clean_db: Client) -> None:
    booked = book(clean_db, RAVI, PRIYA, "checkup", local(next_weekday(WED), "10:00").isoformat())
    clean_db.table("patients").insert({"full_name": "Pytest Person", "phone": "+919800000777"}).execute()
    out = row(clean_db.rpc("reset_demo_fixtures", {}).execute())
    assert out["fixtures_created"] == 32 and out["deleted_patients"] == 1
    assert clean_db.table("appointments").select("id").eq("id", booked["id"]).execute().data == []
    # Staff history survives: Ravi's completed visit.
    done = rows(clean_db.table("appointments").select("id").eq("patient_id", RAVI).eq("status", "completed").execute())
    assert len(done) == 1


def test_calendar_masks_names(clean_db: Client) -> None:
    wed = next_weekday(WED)
    book(clean_db, RAVI, PRIYA, "checkup", local(wed, "10:00").isoformat())
    cal = rows(clean_db.rpc("get_calendar", {"p_from": wed.isoformat(), "p_to": wed.isoformat()}).execute())
    names = {r["patient_display"] for r in cal}
    assert names == {"Ravi K."}
    thu = next_weekday(THU)
    fixtures = rows(clean_db.rpc("get_calendar", {"p_from": thu.isoformat(), "p_to": thu.isoformat()}).execute())
    assert fixtures and all(r["is_fixture"] and r["patient_display"] == "Booked" for r in fixtures)


def test_server_only_functions_not_callable_by_anon(db: Client) -> None:
    # The publishable/anon key is public by design; the functions must still refuse it.
    import subprocess

    from supabase import create_client

    from smiledesk.config import REPO_ROOT, get_settings

    out = subprocess.run(
        ["npx", "--no-install", "supabase", "status", "-o", "env"], cwd=REPO_ROOT, capture_output=True, text=True
    ).stdout
    anon = next(line.split("=", 1)[1].strip('"') for line in out.splitlines() if line.startswith("ANON_KEY="))
    anon_client = create_client(get_settings().supabase_url, anon)
    for fn in ("reset_demo_fixtures", "get_calendar"):
        args = {} if fn == "reset_demo_fixtures" else {"p_from": "2026-01-01", "p_to": "2026-01-02"}
        with pytest.raises(APIError):
            anon_client.rpc(fn, args).execute()
    # RLS: anon can't read patients.
    assert anon_client.table("patients").select("id").execute().data == []
