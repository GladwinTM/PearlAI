"""Recruiter-mode personas: pre-fill the caller ID so nobody has to type a phone number.

Only used when DEMO_MODE=true. The web app mirrors these ids in lib/personas.ts.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Persona:
    id: str
    label: str
    phone: str | None
    description: str


PERSONAS: dict[str, Persona] = {
    p.id: p
    for p in [
        Persona("ravi", "Ravi", "+919800000001", "Existing patient"),
        Persona("anjali", "Anjali", "+919800000002", "New patient"),
        Persona("ravi_meena", "Ravi for Meena", "+919800000001", "Booking for his daughter Meena"),
        Persona("new", "Someone new", None, "No caller ID, never visited"),
    ]
}


def caller_phone_for(persona: str | None) -> str | None:
    p = PERSONAS.get(persona or "")
    return p.phone if p else None
