"""Versioned system prompts: files in prompts/<version>.md, rendered per turn, mirrored into prompt_versions."""

from __future__ import annotations

from datetime import datetime
from functools import lru_cache
from pathlib import Path

from loguru import logger

from smiledesk.agent.clinic import Clinic
from smiledesk.clock import date_context
from smiledesk.db import get_db

PROMPTS_DIR = Path(__file__).parent / "prompts"


def available_versions() -> list[str]:
    return sorted(p.stem for p in PROMPTS_DIR.glob("v*.md"))


@lru_cache
def load_template(version: str) -> str:
    path = PROMPTS_DIR / f"{version}.md"
    if not path.is_file():
        raise FileNotFoundError(f"Prompt version '{version}' not found ({path}). Available: {available_versions()}")
    return path.read_text(encoding="utf-8")


def _fmt_hour(t) -> str:
    return t.strftime("%I:%M %p").lstrip("0").replace(":00", "")


def clinic_block(c: Clinic) -> str:
    lines = ["Dentists (use these ids in tools):"]
    days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    for d in c.dentists:
        hours = ", ".join(
            f"{days[wd]} {_fmt_hour(s)}–{_fmt_hour(e)}"
            for wd, (s, e) in sorted(d.schedule.items(), key=lambda x: x[0] or 7)
        )
        services = ", ".join(sorted(d.services))
        lines.append(f'- {d.full_name} (dentist_id "{d.key}"), {d.specialty}. Does: {services}. Hours: {hours}.')
    lines.append(
        "Visit types: " + "; ".join(f"{t.id} ({t.name}, {t.duration_minutes} min)" for t in c.types.values()) + "."
    )
    lines.append(
        f"Lunch break {_fmt_hour(c.lunch[0])}–{_fmt_hour(c.lunch[1])}. Closed on Sundays. "
        f"New patients (no completed visit yet) can only start before {_fmt_hour(c.new_patient_cutoff)}."
    )
    return "\n".join(lines)


def render(version: str, clinic: Clinic, now: datetime, extra: str = "") -> str:
    text = load_template(version)
    text = text.replace("{{clinic}}", clinic_block(clinic))
    text = text.replace("{{dates}}", date_context(now, clinic.working_by_weekday(), clinic.closed_dates()))
    if extra:
        text += "\n\n" + extra
    return text.strip() + "\n"


def sync_prompt_versions() -> list[str]:
    """Upsert every prompt file into prompt_versions so eval runs can reference them."""
    versions = available_versions()
    payload = [{"id": v, "system_prompt": load_template(v), "notes": f"prompts/{v}.md"} for v in versions]
    if payload:
        get_db().table("prompt_versions").upsert(payload, on_conflict="id").execute()
    logger.info(f"Synced prompt versions: {versions}")
    return versions
