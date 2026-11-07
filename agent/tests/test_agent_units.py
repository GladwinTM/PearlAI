"""Pure unit tests for the agent: phone normalization, safety backstop, date table, grounding. No DB, no LLM."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from smiledesk.agent.grounding import spoken_times, times_in, ungrounded
from smiledesk.agent.safety import check_message
from smiledesk.agent.tools import _parse_pref, normalize_phone, phones_in_text
from smiledesk.clock import date_context, fmt_start, parse_local_datetime

# ── Phone numbers ───────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("9800000001", "+919800000001"),
        ("98000 00001", "+919800000001"),
        ("+91 98000-00001", "+919800000001"),
        ("+919800000001", "+919800000001"),
        ("919800000001", "+919800000001"),
        ("09800000001", "+919800000001"),
        ("(+91) 98000 00001", "+919800000001"),
        ("6123456789", "+916123456789"),
    ],
)
def test_normalize_phone_valid(raw: str, expected: str) -> None:
    assert normalize_phone(raw) == expected


@pytest.mark.parametrize("raw", ["", None, "12345", "5800000001", "98000000011", "0422 000 0000", "abc"])
def test_normalize_phone_invalid(raw: str | None) -> None:
    assert normalize_phone(raw) is None


def test_phones_in_text() -> None:
    text = "I'm Ravi, 98000 00001. My wife's is +91-98000-00002. Booking ref 12345."
    assert phones_in_text(text) == {"+919800000001", "+919800000002"}
    assert phones_in_text("no numbers here, maybe 7 PM") == set()


# ── Safety backstop ─────────────────────────────────────────────


@pytest.mark.parametrize(
    ("text", "rule"),
    [
        ("My face is swollen on one side and I have a fever since last night.", "swelling_with_fever"),
        ("my cheek is swelling and I feel feverish", "swelling_with_fever"),
        ("I'm having trouble swallowing since my tooth started hurting", "breathing_or_swallowing"),
        ("it's hard to breathe and my jaw hurts", "breathing_or_swallowing"),
        ("the bleeding won't stop after my extraction", "heavy_bleeding"),
        ("there is heavy bleeding from my gum", "heavy_bleeding"),
        ("I fell off my bike and hit my face, a tooth is knocked out", "facial_trauma"),
        ("my son had an accident and his front teeth are broken", "facial_trauma"),
        ("the swelling is spreading to my eye", "spreading_swelling"),
    ],
)
def test_safety_triggers(text: str, rule: str) -> None:
    r = check_message(text)
    assert r.triggered and rule in r.rules
    assert "escalate_to_human" in r.instruction and "urgent" in r.instruction


@pytest.mark.parametrize(
    "text",
    [
        "I'd like a cleaning next week",
        "My gums bleed a little when I brush",
        "Do you take insurance?",
        "My tooth is a bit swollen but no fever",
        "How many ibuprofen can I take?",
        "Can I book a checkup at 7 PM?",
    ],
)
def test_safety_does_not_trigger(text: str) -> None:
    assert not check_message(text).triggered


def test_breathing_adds_emergency_department_advice() -> None:
    r = check_message("I can't swallow properly and my face is swollen")
    assert r.breathing_or_swallowing
    assert "emergency department now" in r.instruction


# ── Date table ──────────────────────────────────────────────────

WORKING = {0: [], 1: ["Priya", "Arjun"], 2: ["Priya", "Kavya"], 3: ["Priya", "Arjun"], 4: ["Priya", "Kavya"], 5: ["Priya", "Arjun"], 6: ["Priya", "Arjun"]}  # fmt: skip


def test_date_context_saturday() -> None:
    now = datetime(2026, 11, 7, 14, 5, tzinfo=ZoneInfo("Asia/Kolkata"))  # a Saturday
    block = date_context(now, WORKING)
    assert block.startswith("Now: Saturday 7 Nov 2026, between 2:00 PM and 3:00 PM")
    assert "Tomorrow Sun 8 Nov = 2026-11-08 (CLOSED)" in block
    assert "Mon 9 Nov = 2026-11-09 (Priya, Arjun)" in block
    assert "next Thursday = Thu 12 Nov (2026-11-12)" in block
    assert "next Saturday = Sat 14 Nov (2026-11-14)" in block  # strictly after today
    assert '"next week" = Mon 9 Nov – Sat 14 Nov' in block
    assert '"early next week" = Mon 9 Nov – Tue 10 Nov' in block
    assert "after work" in block and "4:30 PM" in block


def test_date_context_is_hour_stable() -> None:
    """Same prompt text within an hour → LLM prompt cache hits."""
    tz = ZoneInfo("Asia/Kolkata")
    a = date_context(datetime(2026, 11, 9, 10, 1, tzinfo=tz), WORKING)
    b = date_context(datetime(2026, 11, 9, 10, 59, tzinfo=tz), WORKING)
    assert a == b


def test_date_context_marks_closures() -> None:
    from datetime import date

    now = datetime(2026, 11, 7, 9, 0, tzinfo=ZoneInfo("Asia/Kolkata"))
    block = date_context(now, WORKING, frozenset({date(2026, 11, 10)}))
    assert "Tue 10 Nov = 2026-11-10 (CLOSED)" in block


def test_parse_local_datetime_and_fmt_start() -> None:
    dt = parse_local_datetime("2026-11-13T09:00")
    assert dt.utcoffset() is not None and dt.utcoffset().total_seconds() == 5.5 * 3600  # pyright: ignore[reportOptionalMemberAccess]
    assert fmt_start(dt) == "2026-11-13T09:00"
    assert fmt_start(parse_local_datetime("2026-11-13T03:30:00Z")) == "2026-11-13T09:00"
    assert fmt_start(parse_local_datetime("2026-11-13 09:00:00+05:30")) == "2026-11-13T09:00"


@pytest.mark.parametrize(
    ("pref", "label"),
    [("morning", "morning"), ("after work", "evening"), ("evening", "evening"), ("afternoon", "afternoon"),
     ("19:00", "19:00"), ("7 pm", "19:00"), ("7", "19:00"), ("10:30am", "10:30"), ("whenever", None)],
)  # fmt: skip
def test_parse_time_preference(pref: str, label: str | None) -> None:
    assert _parse_pref(pref)[2] == label


# ── Grounding ───────────────────────────────────────────────────


def test_spoken_times() -> None:
    text = "I have nine AM, ten thirty AM, 2 PM, 11:15 a.m. or three forty-five pm."
    assert spoken_times(text) == {"09:00", "10:30", "14:00", "11:15", "15:45"}
    assert spoken_times("twelve PM works, or 12 am") == {"12:00", "00:00"}
    assert spoken_times("We have 3 dentists and I am happy to help") == set()


def test_times_in_tool_results() -> None:
    result = {
        "slots": [{"start": "2026-11-11T09:00", "label": "Wed 11 Nov, 9:00 AM, Dr. Priya"}],
        "note": "before 6 PM",
    }
    assert times_in(result) == {"09:00", "18:00"}


def test_ungrounded() -> None:
    grounded = {"09:00", "10:30"}
    assert ungrounded("How about nine AM or ten thirty AM?", grounded) == set()
    assert ungrounded("I have 9 AM or 2 PM", grounded) == {"14:00"}
