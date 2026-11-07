"""Clinic-timezone helpers and the date table injected into the system prompt on every turn.

LLMs are bad at calendar arithmetic, so the model never computes dates itself: it reads them here.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from smiledesk.config import get_settings

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]  # Python weekday() order
WEEKDAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def clinic_tz() -> ZoneInfo:
    return ZoneInfo(get_settings().clinic_timezone)


def now() -> datetime:
    return datetime.now(clinic_tz())


def pg_dow(d: date) -> int:
    """Postgres day-of-week: 0 = Sunday … 6 = Saturday (matches dentist_schedules.weekday)."""
    return (d.weekday() + 1) % 7


def fmt_day(d: date) -> str:
    return f"{WEEKDAYS[d.weekday()]} {d.day} {d.strftime('%b')}"


def fmt_time(dt: datetime) -> str:
    """'10:30 AM' (the voice prompt tells the model how to say it aloud)."""
    return dt.strftime("%I:%M %p").lstrip("0")


def fmt_slot(dt: datetime) -> str:
    local = dt.astimezone(clinic_tz())
    return f"{fmt_day(local.date())}, {fmt_time(local)}"


def to_local_iso(dt: datetime) -> str:
    """ISO with the clinic offset, e.g. 2026-11-09T15:00:00+05:30 (what tools accept back)."""
    return dt.astimezone(clinic_tz()).isoformat(timespec="minutes")


def fmt_start(dt: datetime) -> str:
    """Compact clinic-local start time for tool I/O: '2026-11-13T09:00' (few tokens, parsed back as local)."""
    return dt.astimezone(clinic_tz()).strftime("%Y-%m-%dT%H:%M")


def parse_local_datetime(value: str) -> datetime:
    """Parse an ISO datetime from the model. Naive values are treated as clinic-local time."""
    v = value.strip().replace(" ", "T", 1)
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=clinic_tz())
    return dt


def date_context(
    current: datetime,
    working: Mapping[int, Sequence[str]],
    closed_dates: frozenset[date] = frozenset(),
    days: int = 14,
) -> str:
    """The block the model reads instead of doing date math.

    `working` maps Postgres weekday → short names of dentists working that day (empty = clinic closed).
    """
    today = current.date()
    # Hour granularity on purpose: the prompt stays byte-identical within the hour, so the LLM server's
    # prompt (KV) cache is reused across turns. Tools never offer past slots anyway.
    hour = current.replace(minute=0, second=0, microsecond=0)
    lines = [
        f"Now: {WEEKDAYS_LONG[today.weekday()]} {today.day} {today.strftime('%b %Y')}, "
        f"between {fmt_time(hour)} and {fmt_time(hour + timedelta(hours=1))} ({current.tzinfo})"
    ]

    cells: list[str] = []
    for i in range(days + 1):
        d = today + timedelta(days=i)
        label = "Today" if i == 0 else "Tomorrow" if i == 1 else None
        names = working.get(pg_dow(d), [])
        status = "CLOSED" if (not names or d in closed_dates) else ", ".join(names)
        prefix = f"{label} " if label else ""
        cells.append(f"{prefix}{fmt_day(d)} = {d.isoformat()} ({status})")
    lines.append("Next 14 days:\n  " + "\n  ".join(cells))

    # "next <weekday>" = the first one strictly after today.
    nexts = []
    for wd in range(7):
        delta = (wd - today.weekday() - 1) % 7 + 1
        nd = today + timedelta(days=delta)
        nexts.append(f"next {WEEKDAYS_LONG[wd]} = {fmt_day(nd)} ({nd.isoformat()})")
    lines.append("Weekday names mean the NEXT occurrence: " + "; ".join(nexts))

    this_mon = today - timedelta(days=today.weekday())
    next_mon = this_mon + timedelta(days=7)
    lines.append(
        f'"this week" = {fmt_day(max(today, this_mon))} – {fmt_day(this_mon + timedelta(days=5))}; '
        f'"next week" = {fmt_day(next_mon)} – {fmt_day(next_mon + timedelta(days=5))}; '
        f'"early next week" = {fmt_day(next_mon)} – {fmt_day(next_mon + timedelta(days=1))}'
    )
    lines.append(
        'Times of day: morning = before 12 PM; afternoon = 12–4:30 PM; "evening" or "after work" = 4:30 PM onward.'
    )
    return "\n".join(lines)
