"""Clinic reference data (dentists, services, schedules, appointment types), cached briefly.

Used by both the prompt (so the model knows ids and who works when) and the tools (validation + reasons).
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from datetime import time as dtime

from smiledesk.db import get_db, rows

_TTL_S = 300.0


@dataclass(frozen=True)
class Dentist:
    id: str
    full_name: str
    specialty: str
    services: frozenset[str]
    schedule: dict[int, tuple[dtime, dtime]]  # postgres weekday → (start, end)

    @property
    def short(self) -> str:
        """'Dr. Priya'"""
        parts = self.full_name.split()
        return " ".join(parts[:2]) if parts and parts[0].lower().startswith("dr") else parts[0]

    @property
    def key(self) -> str:
        """Short id the model uses in tool calls: 'priya' (cheaper and less error-prone than a UUID)."""
        parts = [p for p in self.full_name.lower().replace(".", "").split() if p not in ("dr", "doctor")]
        return parts[0] if parts else self.id

    @property
    def days_text(self) -> str:
        names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        return "/".join(names[d] for d in sorted(self.schedule))


@dataclass(frozen=True)
class ApptType:
    id: str
    name: str
    duration_minutes: int


@dataclass
class Clinic:
    dentists: list[Dentist]
    types: dict[str, ApptType]
    lunch: tuple[dtime, dtime]
    new_patient_cutoff: dtime
    closures: list[tuple[datetime, datetime]] = field(default_factory=list)  # whole-clinic time_off
    loaded_at: float = 0.0

    def dentist(self, ref: str | None) -> Dentist | None:
        """Resolve a dentist by UUID or by (part of) a name, e.g. 'Dr. Priya', 'priya', 'Arjun Menon'."""
        if not ref:
            return None
        r = ref.strip().lower()
        for d in self.dentists:
            if r in (d.id, d.key):
                return d
        r = re.sub(r"^(dr\.?|doctor)\s*", "", r)
        for d in self.dentists:
            if r and r in d.full_name.lower():
                return d
        return None

    def appt_type(self, ref: str | None) -> ApptType | None:
        if not ref:
            return None
        r = ref.strip().lower().replace("-", "_").replace(" ", "_")
        aliases = {
            "root_canal_treatment": "root_canal",
            "rct": "root_canal",
            "check_up": "checkup",
            "consultation": "checkup",
            "braces": "braces_consult",
            "aligners": "braces_consult",
            "scaling": "cleaning",
            "emergency_visit": "emergency",
        }
        r = aliases.get(r, r)
        if r in self.types:
            return self.types[r]
        for t in self.types.values():
            if t.name.lower().replace(" ", "_") == r:
                return t
        return None

    def working_by_weekday(self) -> dict[int, list[str]]:
        out: dict[int, list[str]] = {i: [] for i in range(7)}
        for d in self.dentists:
            for wd in d.schedule:
                out[wd].append(d.short.replace("Dr. ", ""))
        return out

    def closed_dates(self) -> frozenset[date]:
        from smiledesk.clock import clinic_tz

        days: set[date] = set()
        for start, end in self.closures:
            d = start.astimezone(clinic_tz()).date()
            while datetime.combine(d, dtime(0), clinic_tz()) < end:
                days.add(d)
                d = date.fromordinal(d.toordinal() + 1)
        return frozenset(days)


_cache: Clinic | None = None


def _t(v: str) -> dtime:
    return dtime.fromisoformat(v)


def load_clinic(force: bool = False) -> Clinic:
    global _cache
    if _cache and not force and time.monotonic() - _cache.loaded_at < _TTL_S:
        return _cache
    db = get_db()
    settings = rows(db.table("clinic_settings").select("*").execute())[0]
    services: dict[str, set[str]] = {}
    for r in rows(db.table("dentist_services").select("dentist_id, appointment_type_id").execute()):
        services.setdefault(r["dentist_id"], set()).add(r["appointment_type_id"])
    sched: dict[str, dict[int, tuple[dtime, dtime]]] = {}
    for r in rows(db.table("dentist_schedules").select("dentist_id, weekday, start_time, end_time").execute()):
        sched.setdefault(r["dentist_id"], {})[int(r["weekday"])] = (_t(r["start_time"]), _t(r["end_time"]))
    dentists = [
        Dentist(
            r["id"], r["full_name"], r["specialty"], frozenset(services.get(r["id"], set())), sched.get(r["id"], {})
        )
        for r in rows(
            db.table("dentists").select("id, full_name, specialty").eq("is_active", True).order("full_name").execute()
        )
    ]
    types = {
        r["id"]: ApptType(r["id"], r["name"], int(r["duration_minutes"]))
        for r in rows(db.table("appointment_types").select("id, name, duration_minutes").execute())
    }
    closures = [
        (datetime.fromisoformat(r["starts_at"]), datetime.fromisoformat(r["ends_at"]))
        for r in rows(db.table("time_off").select("starts_at, ends_at").is_("dentist_id", "null").execute())
    ]
    _cache = Clinic(
        dentists=dentists,
        types=types,
        lunch=(_t(settings["lunch_start"]), _t(settings["lunch_end"])),
        new_patient_cutoff=_t(settings["new_patient_cutoff"]),
        closures=closures,
        loaded_at=time.monotonic(),
    )
    return _cache
