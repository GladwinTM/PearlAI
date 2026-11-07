"""Grounding check for spoken times: every clock time Pearl says must come from a tool result or clinic hours.

Small local models sometimes "offer" plausible times they never checked. The core loop uses this to catch it
and nudge the model to call check_availability instead of letting a made-up slot reach the patient.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

_NUM = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
}  # fmt: skip
_MIN = {
    "o'clock": 0,
    "oclock": 0,
    "fifteen": 15,
    "thirty": 30,
    "forty five": 45,
    "forty-five": 45,
    "forty": 40,
    "twenty": 20,
    "ten": 10,
    "five": 5,
}
_MER = r"(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])"

_DIGITS = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s*" + _MER, re.I)
_WORDS = re.compile(
    r"\b(" + "|".join(_NUM) + r")(?:[\s-]+(o'?clock|fifteen|thirty|forty[\s-]five|forty|twenty|ten|five))?\s+" + _MER,
    re.I,
)
_ISO = re.compile(r"T(\d{2}):(\d{2})")
_HHMM = re.compile(r"\b(\d{2}):(\d{2})\b")


def _hm(h: int, m: int, mer: str) -> str | None:
    pm = mer.lower().startswith("p")
    if not 1 <= h <= 12 or not 0 <= m <= 59:
        return None
    h24 = (h % 12) + (12 if pm else 0)
    return f"{h24:02d}:{m:02d}"


def spoken_times(text: str) -> set[str]:
    """Clock times mentioned in assistant text, as 'HH:MM' (24h)."""
    out: set[str] = set()
    for m in _DIGITS.finditer(text):
        if t := _hm(int(m.group(1)), int(m.group(2) or 0), m.group(3)):
            out.add(t)
    for m in _WORDS.finditer(text):
        mins = _MIN.get((m.group(2) or "o'clock").lower().replace("-", " "), 0)
        if t := _hm(_NUM[m.group(1).lower()], mins, m.group(3)):
            out.add(t)
    return out


def times_in(value: Any) -> set[str]:
    """All times found anywhere in a tool result (ISO starts, labels like '9:00 AM', FAQ text like '9 AM')."""
    out: set[str] = set()
    if isinstance(value, dict):
        for v in value.values():
            out |= times_in(v)
    elif isinstance(value, list):
        for v in value:
            out |= times_in(v)
    elif isinstance(value, str):
        out |= spoken_times(value)
        out |= {f"{h}:{m}" for h, m in _ISO.findall(value)}
    return out


def ungrounded(text: str, grounded: Iterable[str]) -> set[str]:
    return spoken_times(text) - set(grounded)
