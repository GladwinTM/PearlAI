"""Tool executors against local Supabase, called exactly as the core loop calls them (execute_tool)."""

from __future__ import annotations

from typing import Any

import pytest
from supabase import Client

from smiledesk.agent.tools import TOOL_SCHEMAS, ToolContext, execute_tool
from smiledesk.db import rows
from tests.conftest import ARJUN, MEENA, PRIYA, RAVI, next_weekday

pytestmark = pytest.mark.db

SUN, MON, TUE, WED, THU, FRI, SAT = range(7)


def ctx_with(*phones: str) -> ToolContext:
    return ToolContext(allowed_phones=set(phones))


async def call(ctx: ToolContext, name: str, **args: Any) -> dict[str, Any]:
    result, _ms = await execute_tool(name, args, ctx)
    return result


async def ravi_ctx() -> ToolContext:
    ctx = ctx_with("+919800000001")
    out = await call(ctx, "lookup_patient", phone="98000 00001")
    assert out["found"]
    return ctx


def test_schemas_are_valid_openai_functions() -> None:
    names = [t["function"]["name"] for t in TOOL_SCHEMAS]
    assert names == [
        "lookup_patient", "create_patient", "check_availability", "book_appointment", "list_appointments",
        "reschedule_appointment", "cancel_appointment", "get_clinic_info", "escalate_to_human",
    ]  # fmt: skip
    for t in TOOL_SCHEMAS:
        params = t["function"]["parameters"]
        assert params["type"] == "object"
        assert set(params["required"]) <= set(params["properties"])


# ── lookup / create ─────────────────────────────────────────────


async def test_lookup_family_shares_phone(clean_db: Client) -> None:
    ctx = ctx_with("+919800000001")
    out = await call(ctx, "lookup_patient", phone="+91 98000 00001")
    assert [p["full_name"] for p in out["patients"]] == ["Ravi Kumar", "Meena Ravi"]
    assert [p["patient_id"] for p in out["patients"]] == ["P1", "P2"]
    assert out["patients"][0]["is_new"] is False  # Ravi has a completed visit
    assert out["patients"][1]["is_new"] is True
    assert "share this number" in out["note"]
    assert ctx.known_patient_ids == {RAVI, MEENA}
    assert "aaaaaaaa" not in str(out)  # no UUIDs leak to the model


async def test_lookup_refuses_numbers_the_caller_never_gave(clean_db: Client) -> None:
    out = await call(ctx_with(), "lookup_patient", phone="9800000001")
    assert "error" in out and "Never guess" in out["hint"]


async def test_lookup_unknown_and_invalid(clean_db: Client) -> None:
    out = await call(ctx_with("+919800000555"), "lookup_patient", phone="9800000555")
    assert out["found"] is False and "create_patient" in out["hint"]
    bad = await call(ctx_with(), "lookup_patient", phone="12345")
    assert "error" in bad


async def test_create_patient_and_dedupe(clean_db: Client) -> None:
    ctx = ctx_with()
    a = await call(ctx, "create_patient", full_name="Kiran Das", phone="98000 00777", date_of_birth="1990-02-03")
    assert a["created"] and a["patient_id"] == "P1"
    b = await call(ctx, "create_patient", full_name="kiran das", phone="+919800000777")
    assert b["created"] is False and b["patient_id"] == "P1"
    assert len(rows(clean_db.table("patients").select("id").eq("phone", "+919800000777").execute())) == 1


# ── check_availability ──────────────────────────────────────────


async def test_availability_thursday_full_offers_alternatives(clean_db: Client) -> None:
    ctx = await ravi_ctx()
    out = await call(
        ctx,
        "check_availability",
        date=next_weekday(THU).isoformat(),
        appointment_type="checkup",
        dentist_id="Dr. Priya",
        patient_id="P1",
    )
    assert out["available"] is False
    assert "fully booked" in out["reason"]
    alts = out["nearest_alternatives"]
    assert 1 <= len(alts) <= 6
    assert all(a["dentist_id"] == "priya" for a in alts)
    assert all(a["start"] > next_weekday(THU).isoformat() for a in alts)
    assert ctx.offered  # alternatives are bookable


async def test_availability_root_canal_gap_reason(clean_db: Client) -> None:
    out = await call(
        ctx_with(),
        "check_availability",
        date=next_weekday(MON).isoformat(),
        appointment_type="root_canal",
        dentist_id="arjun",
    )
    assert out["available"] is False
    assert "90 minutes" in out["reason"]
    assert out["nearest_alternatives"]


async def test_availability_reasons(clean_db: Client) -> None:
    ctx = ctx_with()
    sunday = await call(ctx, "check_availability", date=next_weekday(SUN).isoformat(), appointment_type="checkup")
    assert "closed" in sunday["reason"]
    kavya = await call(
        ctx,
        "check_availability",
        date=next_weekday(WED).isoformat(),
        appointment_type="braces_consult",
        dentist_id="kavya",
    )
    assert "only works Tue/Thu" in kavya["reason"]
    priya_rct = await call(
        ctx, "check_availability", date=next_weekday(WED).isoformat(), appointment_type="root canal", dentist_id="priya"
    )
    assert "doesn't do root canals" in priya_rct["reason"]


async def test_availability_new_patient_cutoff(clean_db: Client) -> None:
    ctx = ctx_with("+919800000002")
    await call(ctx, "lookup_patient", phone="9800000002")  # Anjali, new
    out = await call(
        ctx,
        "check_availability",
        date=next_weekday(WED).isoformat(),
        appointment_type="checkup",
        patient_id="P1",
        time_preference="19:00",
    )
    assert out["available"] is True and out["new_patient_rules"] is True
    assert all(s["start"][11:] < "18:00" for s in out["slots"])
    assert "New patients are seen only before 6 PM" in out["note"]


async def test_availability_time_preference_and_spread(clean_db: Client) -> None:
    out = await call(
        ctx_with(),
        "check_availability",
        date=next_weekday(WED).isoformat(),
        appointment_type="checkup",
        time_preference="after work",
    )
    assert out["available"] and out["time_preference"] == "evening"
    assert all(s["start"][11:] >= "16:30" for s in out["slots"])
    assert len(out["slots"]) <= 6


async def test_availability_validation_errors(clean_db: Client) -> None:
    ctx = ctx_with()
    assert "error" in await call(ctx, "check_availability", date="next thursday", appointment_type="checkup")
    assert "error" in await call(
        ctx, "check_availability", date=next_weekday(WED).isoformat(), appointment_type="whitening"
    )
    assert "error" in await call(
        ctx, "check_availability", date=next_weekday(WED).isoformat(), appointment_type="checkup", dentist_id="Dr. Who"
    )
    assert "error" in await call(
        ctx, "check_availability", date=next_weekday(WED).isoformat(), appointment_type="checkup", patient_id="P9"
    )


# ── book / list / reschedule / cancel ───────────────────────────


async def test_full_lifecycle(clean_db: Client) -> None:
    ctx = await ravi_ctx()
    wed, fri = next_weekday(WED).isoformat(), next_weekday(FRI).isoformat()
    avail = await call(
        ctx, "check_availability", date=wed, appointment_type="cleaning", dentist_id="priya", patient_id="P1"
    )
    slot = avail["slots"][0]

    booked = await call(
        ctx,
        "book_appointment",
        patient_id="P1",
        dentist_id=slot["dentist_id"],
        appointment_type="cleaning",
        starts_at=slot["start"],
    )
    assert booked["booked"] and booked["appointment_id"] == "A1" and booked["patient"] == "Ravi Kumar"
    assert ctx.outcome == "booked"
    db_row = rows(clean_db.table("appointments").select("*").eq("patient_id", RAVI).eq("status", "booked").execute())
    assert len(db_row) == 1 and db_row[0]["source"] == "chat" and db_row[0]["dentist_id"] == PRIYA

    listed = await call(ctx, "list_appointments", patient_id="P1")
    assert [a["appointment_id"] for a in listed["appointments"]] == ["A1"]

    new_avail = await call(
        ctx, "check_availability", date=fri, appointment_type="cleaning", dentist_id="priya", patient_id="P1"
    )
    new_slot = new_avail["slots"][0]
    moved = await call(ctx, "reschedule_appointment", appointment_id="A1", new_starts_at=new_slot["start"])
    assert moved["rescheduled"] and moved["appointment_id"] == "A2"
    assert ctx.outcome == "rescheduled"

    cancelled = await call(ctx, "cancel_appointment", appointment_id="A2", reason="travelling")
    assert cancelled["cancelled"] and cancelled["status"] == "cancelled"
    statuses = {
        r["status"]
        for r in rows(
            clean_db.table("appointments").select("status").eq("patient_id", RAVI).eq("source", "chat").execute()
        )
    }
    assert statuses == {"rescheduled", "cancelled"}
    again = await call(ctx, "cancel_appointment", appointment_id="A2")
    assert "already cancelled" in again["error"]


async def test_book_requires_an_offered_slot(clean_db: Client) -> None:
    ctx = await ravi_ctx()
    out = await call(
        ctx,
        "book_appointment",
        patient_id="P1",
        dentist_id="priya",
        appointment_type="checkup",
        starts_at=f"{next_weekday(WED).isoformat()}T10:00",
    )
    assert "wasn't returned by check_availability" in out["error"]


async def test_book_requires_identified_patient(clean_db: Client) -> None:
    ctx = ctx_with()
    out = await call(
        ctx,
        "book_appointment",
        patient_id=RAVI,
        dentist_id="priya",
        appointment_type="checkup",
        starts_at="2026-11-11T10:00",
    )
    assert "hasn't been identified" in out["error"]


async def test_family_booking_sets_booked_by(clean_db: Client) -> None:
    ctx = await ravi_ctx()
    sat = next_weekday(SAT).isoformat()
    avail = await call(
        ctx, "check_availability", date=sat, appointment_type="checkup", patient_id="P2", time_preference="morning"
    )
    slot = avail["slots"][0]
    out = await call(
        ctx,
        "book_appointment",
        patient_id="P2",
        dentist_id=slot["dentist_id"],
        appointment_type="checkup",
        starts_at=slot["start"],
        booked_by_patient_id="P1",
    )
    assert out["booked"] and out["patient"] == "Meena Ravi"
    rec = rows(
        clean_db.table("appointments").select("patient_id, booked_by_patient_id").eq("source", "chat").execute()
    )[0]
    assert rec["patient_id"] == MEENA and rec["booked_by_patient_id"] == RAVI


async def test_slot_taken_meanwhile_returns_alternatives(clean_db: Client) -> None:
    ctx = await ravi_ctx()
    wed = next_weekday(WED).isoformat()
    avail = await call(
        ctx, "check_availability", date=wed, appointment_type="checkup", dentist_id="arjun", patient_id="P1"
    )
    slot = avail["slots"][0]
    # Someone else grabs it first.
    clean_db.rpc("book_appointment", {"p_patient_id": "aaaaaaaa-0000-0000-0000-000000000003", "p_dentist_id": ARJUN,
                                      "p_appointment_type": "checkup", "p_starts_at": slot["start"] + ":00+05:30", "p_source": "chat"}).execute()  # fmt: skip
    out = await call(
        ctx,
        "book_appointment",
        patient_id="P1",
        dentist_id="arjun",
        appointment_type="checkup",
        starts_at=slot["start"],
    )
    assert "no longer available" in out["error"]
    assert out["alternatives"]


async def test_cannot_touch_someone_elses_appointment(clean_db: Client) -> None:
    anjali = ctx_with("+919800000002")
    await call(anjali, "lookup_patient", phone="9800000002")
    a = await call(
        anjali, "check_availability", date=next_weekday(WED).isoformat(), appointment_type="checkup", patient_id="P1"
    )
    booked = await call(
        anjali,
        "book_appointment",
        patient_id="P1",
        dentist_id=a["slots"][0]["dentist_id"],
        appointment_type="checkup",
        starts_at=a["slots"][0]["start"],
    )
    real_id = rows(clean_db.table("appointments").select("id").eq("source", "chat").execute())[0]["id"]
    assert booked["booked"]
    ravi = await ravi_ctx()
    out = await call(ravi, "cancel_appointment", appointment_id=real_id)
    assert "doesn't belong" in out["error"]


# ── info / escalation / robustness ──────────────────────────────


@pytest.mark.ollama
async def test_get_clinic_info_insurance(clean_db: Client) -> None:
    out = await call(ctx_with(), "get_clinic_info", question="Do you take insurance?")
    assert out["results"][0]["title"] == "Insurance"


async def test_escalate_inserts_row(clean_db: Client) -> None:
    ctx = await ravi_ctx()
    out = await call(ctx, "escalate_to_human", reason="pytest swelling with fever", urgency="urgent")
    assert out["escalated"] and "15 minutes" in out["message_for_patient"]
    rec = rows(clean_db.table("escalations").select("*").eq("id", out["escalation_id"]).execute())[0]
    assert rec["urgency"] == "urgent" and rec["patient_id"] == RAVI
    clean_db.table("escalations").delete().eq("id", out["escalation_id"]).execute()


async def test_execute_tool_never_raises(clean_db: Client) -> None:
    ctx = ctx_with()
    unknown, _ = await execute_tool("drop_tables", {}, ctx)
    assert "Unknown tool" in unknown["error"]
    missing, _ = await execute_tool("check_availability", {"date": "2026-11-11"}, ctx)
    assert "Missing required" in missing["error"]
    extra, _ = await execute_tool("lookup_patient", {"phone": "1", "sql": "drop"}, ctx)  # unknown args are dropped
    assert "error" in extra


async def test_booking_needs_a_confirmation_question_for_that_slot(clean_db: Client) -> None:
    ctx = await ravi_ctx()
    avail = await call(
        ctx, "check_availability", date=next_weekday(WED).isoformat(), appointment_type="checkup", dentist_id="priya"
    )
    first, second = avail["slots"][0], avail["slots"][1]
    args = {
        "patient_id": "P1",
        "dentist_id": first["dentist_id"],
        "appointment_type": "checkup",
        "starts_at": first["start"],
    }

    # Offering options and hearing "the first one" is a choice, not a yes.
    ctx.last_assistant_text = f"I have {first['label']} or {second['label']}. Which suits you?"
    out = await call(ctx, "book_appointment", **args)
    assert "Not confirmed" in out["error"] and "Shall I book" in out["hint"]

    # A statement naming the slot (no question) isn't a confirmation either.
    ctx.last_assistant_text = f"Okay, {first['label']}."
    assert "Not confirmed" in (await call(ctx, "book_appointment", **args))["error"]

    # A confirmation question for a different slot doesn't count.
    ctx.last_assistant_text = f"Shall I book a checkup for Ravi with Dr. Priya at {second['label']}?"
    assert "Not confirmed" in (await call(ctx, "book_appointment", **args))["error"]

    # Options listed, then a question about one of them: the question is what the caller answered.
    ctx.last_assistant_text = f"I have {first['label']} or {second['label']}. Shall I book {second['label']}?"
    assert "Not confirmed" in (await call(ctx, "book_appointment", **args))["error"]

    # The caller said yes to a question naming exactly this slot: book it.
    ctx.last_assistant_text = (
        f"Thursday is full. I have {first['label']} or {second['label']}.\n"
        f"Shall I book a checkup for Ravi on {first['label']}?"  # the label ends in "Dr. Priya"
    )
    assert (await call(ctx, "book_appointment", **args))["booked"]
