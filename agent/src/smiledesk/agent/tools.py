"""Agent tools: OpenAI function schemas + executors. The single source of tool logic for chat, voice and evals.

Rules:
- Executors never raise. Failures come back as {"error": "...", "hint": "..."} so the model can recover.
- Writes (book / reschedule / cancel / list) only work for patients identified in THIS conversation
  (via lookup_patient or create_patient). That guards against prompt injection and guessed ids.
- Token-efficient I/O: the model sees short handles (patients "P1", appointments "A1", dentists "priya")
  and compact local times ("2026-11-13T09:00"), never UUIDs. Generating a UUID costs ~25 tokens and is
  easy to mis-copy; on a local 8B model every generated token is latency.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from datetime import time as dtime
from typing import Any, Literal

from loguru import logger
from postgrest.exceptions import APIError

from smiledesk.agent.clinic import ApptType, Clinic, Dentist, load_clinic
from smiledesk.agent.grounding import spoken_times
from smiledesk.clock import clinic_tz, fmt_day, fmt_slot, fmt_start, fmt_time, now, parse_local_datetime, pg_dow
from smiledesk.db import get_db, row, rows
from smiledesk.providers.embeddings import embed_query

ToolResult = dict[str, Any]
MAX_SLOTS = 6


@dataclass
class ToolContext:
    conversation_id: str | None = None
    channel: Literal["chat", "voice"] = "chat"
    known_patient_ids: set[str] = field(default_factory=set)
    # Side effects the core loop records on the conversation row.
    outcome: str | None = None
    patient_id: str | None = None
    # Phone numbers the caller actually said (or caller ID). lookup_patient refuses anything else.
    allowed_phones: set[str] = field(default_factory=set)
    # Slots check_availability actually returned: (start "YYYY-MM-DDTHH:MM", dentist key). Bookings must use one.
    offered: set[tuple[str, str]] = field(default_factory=set)
    # Pearl's last message to the caller before the current turn (set by the chat loop and the voice pipeline).
    # Booking/rescheduling needs it to be a confirmation question naming that slot. None = not tracked: guard off.
    last_assistant_text: str | None = None
    # handle ("P1", "A3") ↔ UUID, per conversation
    _by_handle: dict[str, str] = field(default_factory=dict)
    _by_uuid: dict[str, str] = field(default_factory=dict)

    def handle(self, uuid: str, prefix: str) -> str:
        if uuid in self._by_uuid:
            return self._by_uuid[uuid]
        n = sum(1 for h in self._by_handle if h.startswith(prefix)) + 1
        h = f"{prefix}{n}"
        self._by_handle[h], self._by_uuid[uuid] = uuid, h
        return h

    def resolve(self, ref: Any) -> str | None:
        """Handle or raw UUID → UUID (None if neither)."""
        r = str(ref or "").strip()
        if r.upper() in self._by_handle:
            return self._by_handle[r.upper()]
        if _UUID.fullmatch(r):
            return r.lower()
        return None

    def remember_patient(self, uuid: str) -> str:
        self.known_patient_ids.add(uuid)
        return self.handle(uuid, "P")


_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def assistant_text_before_last_user(messages: list[Any]) -> str:
    """What Pearl said just before the caller's latest message ("" if nothing). Works on chat and Pipecat history."""
    seen_user = False
    for m in reversed(messages):
        if not isinstance(m, dict):
            continue
        role, content = m.get("role"), m.get("content")
        if role == "user" and not seen_user:
            seen_user = True
        elif role == "user":
            return ""
        elif role == "assistant" and seen_user and isinstance(content, str) and content.strip():
            return content
    return ""


def _unconfirmed(ctx: ToolContext, when: datetime) -> ToolResult | None:
    """A write needs the caller's yes to a question that named exactly this slot's time.

    Offering three options and hearing "the first one" is a choice, not a confirmation: small models book right
    there. Code, not the prompt, makes them ask "Shall I book … at 9 AM?" first.
    """
    prev = ctx.last_assistant_text
    if prev is None:
        return None
    # The question Pearl ended on must name exactly this time (options listed before it are fine).
    # "Dr. Priya" isn't the end of a sentence.
    text = re.sub(r"\b(Dr|Mr|Mrs|Ms|St)\.", r"\1", prev)
    questions = re.findall(r"[^.?!\n]*\?", text)
    target = {when.strftime("%H:%M")}
    if questions:
        asked = spoken_times(questions[-1])
        # "Shall I book Friday at 9 AM?", or "The earliest is Friday at 9 AM. Shall I book it?" (one time in total).
        if asked == target or (not asked and spoken_times(text) == target):
            return None
    return err(
        "Not confirmed yet: the caller hasn't said yes to this exact slot.",
        f"Don't book yet and don't say it's booked. Ask one question naming who, the visit, the dentist, "
        f'{fmt_day(when)} and {fmt_time(when)} ("Shall I book …?"), then wait for their yes.',
    )


def err(error: str, hint: str = "") -> ToolResult:
    return {"error": error, "hint": hint} if hint else {"error": error}


# ── Phone numbers ───────────────────────────────────────────────


_PHONE_IN_TEXT = re.compile(r"(?:\+?\d[\d\s().-]{8,16}\d)")


def phones_in_text(text: str) -> set[str]:
    """Indian mobile numbers mentioned in free text, normalized to E.164."""
    return {p for m in _PHONE_IN_TEXT.findall(text or "") if (p := normalize_phone(m))}


def normalize_phone(raw: str | None) -> str | None:
    """Indian numbers → E.164. '98000 00001', '09800000001', '+91-98000-00001' → '+919800000001'."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    elif len(digits) == 13 and digits.startswith("091"):
        digits = digits[3:]
    if len(digits) == 10 and digits[0] in "6789":
        return "+91" + digits
    return None


# ── Schemas ─────────────────────────────────────────────────────

_TYPE_ENUM = ["checkup", "cleaning", "root_canal", "braces_consult", "emergency"]

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "lookup_patient",
            "description": "Find patients by phone number. Families can share one number, so several patients may come back. "
            "Returns each patient's id, whether they are new (no completed visit), and upcoming appointments.",
            "parameters": {
                "type": "object",
                "properties": {"phone": {"type": "string", "description": "Phone number as the caller said it"}},
                "required": ["phone"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_patient",
            "description": "Register a new patient. Use only after lookup_patient found no matching person.",
            "parameters": {
                "type": "object",
                "properties": {
                    "full_name": {"type": "string"},
                    "phone": {"type": "string"},
                    "date_of_birth": {"type": "string", "description": "YYYY-MM-DD, optional"},
                },
                "required": ["full_name", "phone"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_availability",
            "description": "Real open slots for one date. Call it as soon as you know the visit type and day, BEFORE "
            "asking about times. If nothing is free it explains why and returns the nearest alternatives, so do not "
            "call it repeatedly day by day.",
            "parameters": {
                "type": "object",
                "properties": {
                    "date": {"type": "string", "description": "YYYY-MM-DD, taken from the date table"},
                    "appointment_type": {"type": "string", "enum": _TYPE_ENUM},
                    "dentist_id": {
                        "type": "string",
                        "description": 'e.g. "priya", only if the patient asked for a dentist',
                    },
                    "patient_id": {"type": "string", "description": 'e.g. "P1", so new-patient rules apply'},
                    "time_preference": {
                        "type": "string",
                        "description": "morning | afternoon | evening | HH:MM (24h). 'after work' = evening",
                    },
                },
                "required": ["date", "appointment_type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "book_appointment",
            "description": "Book a slot returned by check_availability. ONLY call after the patient explicitly said yes "
            "to the full summary (who, what, dentist, day, time).",
            "parameters": {
                "type": "object",
                "properties": {
                    "patient_id": {"type": "string", "description": 'Handle of the person being treated, e.g. "P2"'},
                    "dentist_id": {"type": "string"},
                    "appointment_type": {"type": "string", "enum": _TYPE_ENUM},
                    "starts_at": {
                        "type": "string",
                        "description": "The slot's start exactly as check_availability returned it",
                    },
                    "booked_by_patient_id": {
                        "type": "string",
                        "description": "If booking for a family member, the caller's own handle",
                    },
                },
                "required": ["patient_id", "dentist_id", "appointment_type", "starts_at"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_appointments",
            "description": "Upcoming booked appointments for a patient (to reschedule or cancel).",
            "parameters": {
                "type": "object",
                "properties": {"patient_id": {"type": "string"}},
                "required": ["patient_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reschedule_appointment",
            "description": "Move an existing appointment to a new free slot (atomic). Confirm with the patient first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "appointment_id": {"type": "string"},
                    "new_starts_at": {"type": "string", "description": "start from check_availability"},
                    "new_dentist_id": {"type": "string", "description": "Only if changing dentist"},
                },
                "required": ["appointment_id", "new_starts_at"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_appointment",
            "description": "Cancel a booked appointment. Confirm with the patient first.",
            "parameters": {
                "type": "object",
                "properties": {"appointment_id": {"type": "string"}, "reason": {"type": "string"}},
                "required": ["appointment_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_clinic_info",
            "description": "Search the clinic FAQ: prices, payment, insurance, location, parking, hours, policies, "
            "first visit, aftercare, braces. Use it for ANY factual question about the clinic.",
            "parameters": {
                "type": "object",
                "properties": {"question": {"type": "string"}},
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "escalate_to_human",
            "description": "Hand the patient to a staff member. urgency='urgent' for red-flag symptoms "
            "(swelling with fever, trouble breathing or swallowing, heavy bleeding, facial injury).",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {"type": "string"},
                    "urgency": {"type": "string", "enum": ["urgent", "normal"]},
                    "patient_id": {"type": "string"},
                },
                "required": ["reason", "urgency"],
            },
        },
    },
]

TOOL_NAMES = [t["function"]["name"] for t in TOOL_SCHEMAS]


# ── Helpers ─────────────────────────────────────────────────────


def _parse_date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value).strip()[:10])
    except ValueError:
        return None


def _known_patient(ctx: ToolContext, ref: Any) -> tuple[str, None] | tuple[None, ToolResult]:
    if not ref:
        return None, err("patient_id is required.", "Call lookup_patient with the caller's phone number first.")
    uuid = ctx.resolve(ref)
    if not uuid or uuid not in ctx.known_patient_ids:
        return None, err(
            f"Patient '{ref}' hasn't been identified in this conversation.",
            "Call lookup_patient with the caller's phone number (or create_patient) and use a handle it returns.",
        )
    return uuid, None


def _is_new_patient(patient_id: str) -> bool:
    res = (
        get_db()
        .table("appointments")
        .select("id")
        .eq("patient_id", patient_id)
        .eq("status", "completed")
        .limit(1)
        .execute()
    )
    return not rows(res)


def _upcoming(ctx: ToolContext, patient_ids: list[str]) -> list[dict[str, Any]]:
    if not patient_ids:
        return []
    res = (
        get_db()
        .table("appointments")
        .select(
            "id, patient_id, starts_at, appointment_type_id, dentists(full_name), "
            "patients!appointments_patient_id_fkey(full_name)"
        )
        .in_("patient_id", patient_ids)
        .eq("status", "booked")
        .gte("starts_at", now().isoformat())
        .order("starts_at")
        .execute()
    )
    out = []
    for r in rows(res):
        when = datetime.fromisoformat(r["starts_at"])
        out.append(
            {
                "appointment_id": ctx.handle(r["id"], "A"),
                "patient_uuid": r["patient_id"],
                "patient": (r.get("patients") or {}).get("full_name"),
                "type": r["appointment_type_id"],
                "dentist": (r.get("dentists") or {}).get("full_name"),
                "when": fmt_slot(when),
            }
        )
    return out


def _rpc_slots(d: date, type_id: str, dentist_id: str | None, is_new: bool) -> list[dict[str, Any]]:
    res = (
        get_db()
        .rpc(
            "get_available_slots",
            {
                "p_date": d.isoformat(),
                "p_appointment_type": type_id,
                "p_dentist_id": dentist_id,
                "p_is_new_patient": is_new,
            },
        )
        .execute()
    )
    return rows(res)


def _parse_pref(pref: str | None) -> tuple[tuple[dtime, dtime] | None, dtime | None, str | None]:
    """→ (window, target_time, normalized label)."""
    if not pref:
        return None, None, None
    p = pref.strip().lower()
    if p in ("morning", "am", "before noon"):
        return (dtime(0), dtime(12)), None, "morning"
    if p in ("afternoon", "lunchtime", "midday"):
        return (dtime(12), dtime(16, 30)), None, "afternoon"
    if p in ("evening", "after work", "after office", "late", "night", "pm evening"):
        return (dtime(16, 30), dtime(23, 59)), None, "evening"
    m = re.match(r"^(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?$", p)
    if m:
        h, mi, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3)
        if ap == "pm" and h < 12:
            h += 12
        if ap == "am" and h == 12:
            h = 0
        if not ap and 1 <= h <= 7:  # "at 5" in a clinic context means 5 PM
            h += 12
        if 0 <= h <= 23 and 0 <= mi <= 59:
            return None, dtime(h, mi), f"{h:02d}:{mi:02d}"
    return None, None, None


def _local_t(s: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(s["starts_at"]).astimezone(clinic_tz())


def _minutes(t: dtime) -> int:
    return t.hour * 60 + t.minute


def _pick(
    slots: list[dict[str, Any]], window: tuple[dtime, dtime] | None, target: dtime | None, limit: int
) -> tuple[list[dict[str, Any]], bool]:
    """Choose up to `limit` slots near the preference, spread ≥30 min apart per dentist. → (picked, matched_pref)."""
    pool = slots
    matched = True
    if window:
        inside = [s for s in slots if window[0] <= _local_t(s).time() < window[1]]
        matched = bool(inside)
        if inside:
            pool = inside
        else:  # nothing in the window: offer the closest times to it
            edge = window[0] if window[0] > dtime(0) else window[1]
            target = edge
    if target:
        pool = sorted(pool, key=lambda s: (abs(_minutes(_local_t(s).time()) - _minutes(target)), _local_t(s)))
    picked: list[dict[str, Any]] = []
    for s in pool:
        t = _local_t(s)
        if any(p["dentist_id"] == s["dentist_id"] and abs((_local_t(p) - t).total_seconds()) < 1800 for p in picked):
            continue
        picked.append(s)
        if len(picked) >= limit:
            break
    if len(picked) < limit:  # fill with whatever is left
        for s in pool:
            if s not in picked:
                picked.append(s)
            if len(picked) >= limit:
                break
    picked.sort(key=_local_t)
    return picked, matched


def _fmt(s: dict[str, Any]) -> dict[str, Any]:
    t = _local_t(s)
    d = load_clinic().dentist(s["dentist_id"])
    short = d.short if d else s["dentist_name"]
    return {"start": fmt_start(t), "dentist_id": d.key if d else s["dentist_id"], "label": f"{fmt_slot(t)}, {short}"}


def _why_none(c: Clinic, d: date, t: ApptType, dentist: Dentist | None, is_new: bool) -> str:
    day = fmt_day(d)
    today = now().date()
    if d < today:
        return f"{day} is in the past."
    eligible = [x for x in c.dentists if t.id in x.services]
    if not any(pg_dow(d) in x.schedule for x in c.dentists) or d in c.closed_dates():
        return f"The clinic is closed on {day}." + (" We're closed on Sundays." if pg_dow(d) == 0 else "")
    if dentist and t.id not in dentist.services:
        who = " and ".join(x.full_name for x in eligible) or "nobody"
        return f"{dentist.full_name} doesn't do {t.name.lower()}s; {who} does."
    if dentist and pg_dow(d) not in dentist.schedule:
        return f"{dentist.full_name} only works {dentist.days_text}, not {day.split()[0]}."
    pool = [dentist] if dentist else eligible
    working = [x for x in pool if pg_dow(d) in x.schedule]
    if not working:
        names = "; ".join(f"{x.full_name} works {x.days_text}" for x in eligible)
        return f"Nobody who does {t.name.lower()}s works on {day}. {names}."
    ids = [x.id for x in working]
    if is_new and any(_rpc_slots(d, t.id, i, False) for i in ids):
        return f"New patients are seen only before {c.new_patient_cutoff.strftime('%I %p').lstrip('0')}, and there are no earlier openings on {day}."
    if t.duration_minutes > 30:
        short = [
            s
            for i in ids
            for s in _rpc_slots(d, "checkup", i, is_new)
            if i in {x.id for x in c.dentists if "checkup" in x.services}
        ]
        if short:
            return f"A {t.name.lower()} needs {t.duration_minutes} minutes and the free gaps on {day} are shorter than that."
    if d == today:
        return "There are no more openings today."
    who = working[0].full_name + " is" if dentist else "All our dentists are"
    return f"{who} fully booked on {day}."


def _alternatives(
    c: Clinic,
    after: date,
    t: ApptType,
    dentist: Dentist | None,
    is_new: bool,
    window: tuple[dtime, dtime] | None,
    target: dtime | None,
) -> list[dict[str, Any]]:
    """Nearest openings on the next open days (checks up to 7 open days), max MAX_SLOTS, ≤2 per day."""
    found: list[dict[str, Any]] = []
    open_days_checked = 0
    d = after
    closed = c.closed_dates()
    for _ in range(21):
        d = d + timedelta(days=1)
        if d in closed or not any(pg_dow(d) in x.schedule for x in c.dentists):
            continue
        open_days_checked += 1
        day_slots = _rpc_slots(d, t.id, dentist.id if dentist else None, is_new)
        if day_slots:
            picked, _ = _pick(day_slots, window, target, 2)
            found.extend(_fmt(s) for s in picked)
        if len(found) >= MAX_SLOTS or open_days_checked >= 7:
            break
    return found[:MAX_SLOTS]


# ── Executors (sync; run in a worker thread) ────────────────────


def _public(a: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in a.items() if k != "patient_uuid"}


def lookup_patient(ctx: ToolContext, phone: str) -> ToolResult:
    e164 = normalize_phone(phone)
    if not e164:
        return err(f"'{phone}' isn't a valid Indian mobile number.", "Ask for the 10-digit mobile number.")
    if e164 not in ctx.allowed_phones:
        return err(
            "The caller hasn't given this number in the conversation.",
            "Ask the caller for their mobile number and use exactly what they say. Never guess a number.",
        )
    found = rows(
        get_db()
        .table("patients")
        .select("id, full_name, date_of_birth")
        .eq("phone", e164)
        .order("created_at")
        .execute()
    )
    if not found:
        return {
            "found": False,
            "phone": e164,
            "hint": "No patient with this number. Ask for their full name and use create_patient.",
        }
    ids = [p["id"] for p in found]
    for i in ids:
        ctx.remember_patient(i)
    if ctx.patient_id is None:
        ctx.patient_id = ids[0]
    upcoming = _upcoming(ctx, ids)
    patients = [
        {
            "patient_id": ctx.handle(p["id"], "P"),
            "full_name": p["full_name"],
            "date_of_birth": p["date_of_birth"],
            "is_new": _is_new_patient(p["id"]),
            "upcoming": [_public(a) for a in upcoming if a["patient_uuid"] == p["id"]],
        }
        for p in found
    ]
    out: ToolResult = {
        "found": True,
        "phone": e164,
        "patients": patients,
        "next_step": "If the caller asked a question about the clinic (prices, insurance, parking, hours, payment, "
        "policies), call get_clinic_info now. If they said what visit and which day they want, call check_availability "
        "now (don't ask for a time of day first). Otherwise ask what they need.",
    }
    if len(patients) > 1:
        out["note"] = (
            f"{len(patients)} people share this number. Book with the patient_id of the person being treated: "
            "if the caller already said it's for themselves (or named the person), use that; ask only if it's unclear."
        )
    return out


def create_patient(ctx: ToolContext, full_name: str, phone: str, date_of_birth: str | None = None) -> ToolResult:
    name = " ".join(str(full_name).split())
    if len(name) < 2:
        return err("A full name is required.")
    e164 = normalize_phone(phone)
    if not e164:
        return err(f"'{phone}' isn't a valid Indian mobile number.", "Ask for the 10-digit mobile number.")
    dob = _parse_date(date_of_birth) if date_of_birth else None
    existing = rows(get_db().table("patients").select("id, full_name").eq("phone", e164).execute())
    for p in existing:
        if p["full_name"].lower() == name.lower():
            return {
                "created": False,
                "patient_id": ctx.remember_patient(p["id"]),
                "full_name": p["full_name"],
                "note": "Already registered.",
            }
    payload: dict[str, Any] = {"full_name": name, "phone": e164}
    if dob:
        payload["date_of_birth"] = dob.isoformat()
    p = rows(get_db().table("patients").insert(payload).execute())[0]
    handle = ctx.remember_patient(p["id"])
    ctx.patient_id = ctx.patient_id or p["id"]
    return {"created": True, "patient_id": handle, "full_name": p["full_name"], "is_new": True}


def check_availability(
    ctx: ToolContext,
    date: str,
    appointment_type: str,
    dentist_id: str | None = None,
    patient_id: str | None = None,
    time_preference: str | None = None,
) -> ToolResult:
    c = load_clinic()
    d = _parse_date(date)
    if not d:
        return err(f"Invalid date '{date}'.", "Use YYYY-MM-DD from the date table.")
    t = c.appt_type(appointment_type)
    if not t:
        return err(f"Unknown appointment type '{appointment_type}'.", f"Use one of: {', '.join(c.types)}.")
    dentist = c.dentist(dentist_id) if dentist_id else None
    if dentist_id and not dentist:
        return err(f"Unknown dentist '{dentist_id}'.", "Use a dentist id from the clinic list, or leave it out.")
    if d > now().date() + timedelta(days=90):
        return err("We only book up to 90 days ahead.")

    is_new = False
    if patient_id:
        pid, bad = _known_patient(ctx, patient_id)
        if bad:
            return bad
        is_new = _is_new_patient(str(pid))

    window, target, pref_label = _parse_pref(time_preference)
    base: ToolResult = {
        "date": d.isoformat(),
        "day": fmt_day(d),
        "appointment_type": t.id,
        "duration_minutes": t.duration_minutes,
        "new_patient_rules": is_new,
    }
    if dentist:
        base["dentist"] = dentist.full_name
    if pref_label:
        base["time_preference"] = pref_label

    slots = _rpc_slots(d, t.id, dentist.id if dentist else None, is_new) if d >= now().date() else []
    if slots:
        picked, matched = _pick(slots, window, target, MAX_SLOTS)
        out = {**base, "available": True, "slots": [_fmt(s) for s in picked], "total_open_slots": len(slots)}
        notes = []
        if pref_label and window and not matched:
            notes.append(f"No {pref_label} openings on {fmt_day(d)}; these are the closest times.")
        if target:
            exact = any(_local_t(s).time() == target for s in slots)
            if not exact:
                if is_new and target >= c.new_patient_cutoff:
                    notes.append(
                        f"New patients are seen only before {c.new_patient_cutoff.strftime('%I %p').lstrip('0')}; "
                        "these are the closest earlier times."
                    )
                else:
                    notes.append(
                        f"{target.strftime('%I:%M %p').lstrip('0')} isn't available; these are the closest times."
                    )
        if notes:
            out["note"] = " ".join(notes)
        return _remember_offers(ctx, out)

    return _remember_offers(ctx, _unavailable(ctx, c, d, t, dentist, is_new, window, target, base))


def _remember_offers(ctx: ToolContext, out: ToolResult) -> ToolResult:
    for key in ("slots", "nearest_alternatives", "other_dentists_same_day"):
        for slot in out.get(key) or []:
            ctx.offered.add((slot["start"], slot["dentist_id"]))
    return out


def _unavailable(
    ctx: ToolContext,
    c: Clinic,
    d: date,
    t: ApptType,
    dentist: Dentist | None,
    is_new: bool,
    window: tuple[dtime, dtime] | None,
    target: dtime | None,
    base: ToolResult,
) -> ToolResult:
    reason = _why_none(c, d, t, dentist, is_new)
    out = {**base, "available": False, "reason": reason}
    out["nearest_alternatives"] = _alternatives(
        c, max(d, now().date() - timedelta(days=1)), t, dentist, is_new, window, target
    )
    if dentist:
        others = [x for x in c.dentists if x.id != dentist.id and t.id in x.services and pg_dow(d) in x.schedule]
        same_day = [s for x in others for s in _rpc_slots(d, t.id, x.id, is_new)] if d >= now().date() else []
        if same_day:
            out["other_dentists_same_day"] = [_fmt(s) for s in _pick(same_day, window, target, 3)[0]]
    return out


def _appt_summary(ctx: ToolContext, a: dict[str, Any], c: Clinic) -> dict[str, Any]:
    when = datetime.fromisoformat(a["starts_at"])
    dent = c.dentist(a["dentist_id"])
    typ = c.types.get(a["appointment_type_id"])
    return {
        "appointment_id": ctx.handle(a["id"], "A"),
        "type": a["appointment_type_id"],
        "dentist": dent.full_name if dent else a["dentist_id"],
        "when": fmt_slot(when),
        "start": fmt_start(when),
        "duration_minutes": typ.duration_minutes if typ else None,
        "status": a["status"],
    }


def _map_booking_error(e: APIError) -> ToolResult:
    msg = str(e.message or "")
    if "SLOT_UNAVAILABLE" in msg:
        return err(
            "That slot is no longer available.", "Call check_availability again and offer the closest alternatives."
        )
    if e.code == "23P01":
        return err("This patient already has another appointment at that time.", "Pick a different time.")
    if "PATIENT_NOT_FOUND" in msg:
        return err("Patient not found.", "Use lookup_patient or create_patient first.")
    if "APPOINTMENT_NOT_ACTIVE" in msg:
        return err("That appointment is no longer active.", "Call list_appointments to see current bookings.")
    if e.code == "22P02":
        return err("An id or timestamp was malformed.", "Use ids and starts_at exactly as returned by earlier tools.")
    logger.warning(f"booking error {e.code}: {msg}")
    return err(f"Booking failed: {msg}")


def book_appointment(
    ctx: ToolContext,
    patient_id: str,
    dentist_id: str,
    appointment_type: str,
    starts_at: str,
    booked_by_patient_id: str | None = None,
) -> ToolResult:
    pid, bad = _known_patient(ctx, patient_id)
    if bad:
        return bad
    booked_by: str | None = None
    if booked_by_patient_id:
        booked_by, bad = _known_patient(ctx, booked_by_patient_id)
        if bad:
            return bad
    c = load_clinic()
    dentist = c.dentist(dentist_id)
    t = c.appt_type(appointment_type)
    if not dentist or not t:
        return err("Unknown dentist or appointment type.", "Use values returned by check_availability.")
    try:
        when = parse_local_datetime(starts_at)
    except ValueError:
        return err(f"Invalid starts_at '{starts_at}'.", "Use starts_at exactly as returned by check_availability.")
    if (fmt_start(when), dentist.key) not in ctx.offered:
        return err(
            "That time wasn't returned by check_availability in this conversation.",
            "Call check_availability for that day, offer the real times, and confirm with the patient before booking.",
        )
    if bad := _unconfirmed(ctx, when):
        return bad
    params = {
        "p_patient_id": pid,
        "p_dentist_id": dentist.id,
        "p_appointment_type": t.id,
        "p_starts_at": when.isoformat(),
        "p_source": ctx.channel,
        "p_conversation_id": ctx.conversation_id,
        "p_booked_by": booked_by if booked_by and booked_by != pid else None,
    }
    try:
        a = row(get_db().rpc("book_appointment", params).execute())
    except APIError as e:
        out = _map_booking_error(e)
        if "no longer available" in out.get("error", ""):
            alt = check_availability(ctx, when.date().isoformat(), t.id, dentist.id, patient_id, when.strftime("%H:%M"))
            out["alternatives"] = alt.get("slots") or alt.get("nearest_alternatives") or []
        return out
    ctx.outcome, ctx.patient_id = "booked", str(pid)
    s = _appt_summary(ctx, a, c)
    name = rows(get_db().table("patients").select("full_name").eq("id", pid).execute())[0]["full_name"]
    return {"booked": True, **s, "patient": name, "summary": f"{t.name} with {s['dentist']} on {s['when']} for {name}"}


def list_appointments(ctx: ToolContext, patient_id: str) -> ToolResult:
    pid, bad = _known_patient(ctx, patient_id)
    if bad:
        return bad
    appts = _upcoming(ctx, [str(pid)])
    return {"patient_id": ctx.handle(str(pid), "P"), "appointments": [_public(a) for a in appts]}


def _owned_appointment(ctx: ToolContext, appointment_id: str) -> dict[str, Any] | ToolResult:
    uuid = ctx.resolve(appointment_id)
    if not uuid:
        return err(
            f"Unknown appointment_id '{appointment_id}'.", "Use an appointment_id (like A1) from list_appointments."
        )
    found = rows(get_db().table("appointments").select("*").eq("id", uuid).execute())
    if not found:
        return err("Appointment not found.", "Call list_appointments.")
    a = found[0]
    if a["patient_id"] not in ctx.known_patient_ids and a.get("booked_by_patient_id") not in ctx.known_patient_ids:
        return err("That appointment doesn't belong to the identified caller.", "Call lookup_patient first.")
    return a


def reschedule_appointment(
    ctx: ToolContext, appointment_id: str, new_starts_at: str, new_dentist_id: str | None = None
) -> ToolResult:
    a = _owned_appointment(ctx, appointment_id)
    if "error" in a:
        return a
    c = load_clinic()
    dentist = c.dentist(new_dentist_id) if new_dentist_id else None
    if new_dentist_id and not dentist:
        return err(f"Unknown dentist '{new_dentist_id}'.")
    try:
        when = parse_local_datetime(new_starts_at)
    except ValueError:
        return err(f"Invalid new_starts_at '{new_starts_at}'.", "Use starts_at from check_availability.")
    target_dentist = dentist or c.dentist(a["dentist_id"])
    if target_dentist is None or (fmt_start(when), target_dentist.key) not in ctx.offered:
        return err(
            "That time wasn't returned by check_availability in this conversation.",
            "Call check_availability for the new day, offer the real times, and confirm before rescheduling.",
        )
    if bad := _unconfirmed(ctx, when):
        return bad
    try:
        new = row(
            get_db()
            .rpc(
                "reschedule_appointment",
                {
                    "p_appointment_id": a["id"],
                    "p_new_starts_at": when.isoformat(),
                    "p_new_dentist_id": dentist.id if dentist else None,
                    "p_source": ctx.channel,
                    "p_conversation_id": ctx.conversation_id,
                },
            )
            .execute()
        )
    except APIError as e:
        return _map_booking_error(e)
    ctx.outcome, ctx.patient_id = "rescheduled", a["patient_id"]
    old_when = fmt_slot(datetime.fromisoformat(a["starts_at"]))
    s = _appt_summary(ctx, new, c)
    return {
        "rescheduled": True,
        "old_when": old_when,
        **s,
        "summary": f"Moved from {old_when} to {s['when']} with {s['dentist']}",
    }


def cancel_appointment(ctx: ToolContext, appointment_id: str, reason: str | None = None) -> ToolResult:
    a = _owned_appointment(ctx, appointment_id)
    if "error" in a:
        return a
    if a["status"] != "booked":
        return err(f"That appointment is already {a['status']}.", "Call list_appointments to see current bookings.")
    notes = (
        " | ".join(x for x in [a.get("notes"), f"Cancelled via {ctx.channel}: {reason}" if reason else None] if x)
        or None
    )
    updated = rows(
        get_db()
        .table("appointments")
        .update({"status": "cancelled", "notes": notes})
        .eq("id", a["id"])
        .eq("status", "booked")
        .execute()
    )
    if not updated:
        return err("That appointment could not be cancelled (it changed meanwhile).", "Call list_appointments.")
    ctx.outcome, ctx.patient_id = "cancelled", a["patient_id"]
    return {"cancelled": True, **_appt_summary(ctx, updated[0], load_clinic())}


def escalate_to_human(
    ctx: ToolContext, reason: str, urgency: str = "normal", patient_id: str | None = None
) -> ToolResult:
    urgency = "urgent" if str(urgency).lower() == "urgent" else "normal"
    resolved = ctx.resolve(patient_id) if patient_id else None
    pid = resolved if resolved in ctx.known_patient_ids else ctx.patient_id
    rec = rows(
        get_db()
        .table("escalations")
        .insert(
            {"conversation_id": ctx.conversation_id, "patient_id": pid, "urgency": urgency, "reason": str(reason)[:500]}
        )
        .execute()
    )[0]
    ctx.outcome = "escalated"
    message = (
        "A staff member will call you within 15 minutes."
        if urgency == "urgent"
        else "A staff member will call you back today during clinic hours."
    )
    return {"escalated": True, "escalation_id": rec["id"], "urgency": urgency, "message_for_patient": message}


async def get_clinic_info(ctx: ToolContext, question: str) -> ToolResult:
    q = str(question).strip()
    if not q:
        return err("Empty question.")
    vec = await embed_query(q)
    res = await asyncio.to_thread(
        lambda: rows(
            get_db().rpc("match_kb", {"query_embedding": vec, "match_count": 4, "min_similarity": 0.3}).execute()
        )
    )
    if not res:
        return {
            "results": [],
            "hint": "Nothing in the clinic FAQ covers this. Say you don't know and offer to connect them to staff.",
        }
    if ctx.outcome is None:
        ctx.outcome = "info"
    return {
        "results": [
            {"title": r["title"], "content": r["content"], "similarity": round(float(r["similarity"]), 3)} for r in res
        ]
    }


SyncExecutor = Callable[..., ToolResult]
_SYNC: dict[str, SyncExecutor] = {
    "lookup_patient": lookup_patient,
    "create_patient": create_patient,
    "check_availability": check_availability,
    "book_appointment": book_appointment,
    "list_appointments": list_appointments,
    "reschedule_appointment": reschedule_appointment,
    "cancel_appointment": cancel_appointment,
    "escalate_to_human": escalate_to_human,
}
_ASYNC: dict[str, Callable[..., Awaitable[ToolResult]]] = {"get_clinic_info": get_clinic_info}
_ALLOWED_ARGS: dict[str, set[str]] = {
    t["function"]["name"]: set(t["function"]["parameters"]["properties"]) for t in TOOL_SCHEMAS
}
_REQUIRED_ARGS: dict[str, list[str]] = {
    t["function"]["name"]: list(t["function"]["parameters"].get("required", [])) for t in TOOL_SCHEMAS
}


async def execute_tool(name: str, args: dict[str, Any] | None, ctx: ToolContext) -> tuple[ToolResult, int]:
    """Run a tool by name. Returns (result, latency_ms). Never raises."""
    t0 = time.perf_counter()
    try:
        if name not in _ALLOWED_ARGS:
            return err(f"Unknown tool '{name}'.", f"Available tools: {', '.join(TOOL_NAMES)}."), 0
        a = {k: v for k, v in (args or {}).items() if k in _ALLOWED_ARGS[name] and v not in (None, "", "null")}
        missing = [k for k in _REQUIRED_ARGS[name] if k not in a]
        if missing:
            return err(f"Missing required argument(s): {', '.join(missing)}."), 0
        if name in _ASYNC:
            result = await _ASYNC[name](ctx, **a)
        else:
            result = await asyncio.to_thread(_SYNC[name], ctx, **a)
    except Exception as e:
        logger.exception(f"tool {name} crashed")
        result = err(
            f"The {name} tool failed: {e.__class__.__name__}.",
            "Apologise briefly and offer to connect the patient to staff.",
        )
    return result, int((time.perf_counter() - t0) * 1000)
