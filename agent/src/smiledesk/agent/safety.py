"""Red-flag symptom detector: a deterministic backstop that runs on every user message BEFORE the LLM.

The prompt already describes the emergency protocol; this makes sure a small model can't miss it.
It is deliberately simple and over-inclusive: a false positive costs one escalation, a miss can cost much more.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_NEG = r"(?<!no )(?<!not )(?<!without )(?<!don't have )(?<!dont have )(?<!no high )"

SWELLING = re.compile(r"\b(swell\w*|swollen|puff(y|ed|iness)|abscess)\b", re.I)
FEVER = re.compile(_NEG + r"\b(fever\w*|feverish|temperature|chills|shivering)\b", re.I)

BREATH_SWALLOW = re.compile(
    r"\b(can'?t|cannot|can not|unable to|difficulty|difficult|trouble|hard to|struggling to|problem)\b"
    r"[\w\s,]{0,20}?\b(breath\w*|swallow\w*)\b",
    re.I,
)
SHORT_OF_BREATH = re.compile(r"\b(short(ness)? of breath|choking|throat (is )?closing)\b", re.I)

BLEEDING = re.compile(
    r"\b(heavy|heavily|lots? of|a lot of|so much|non-?stop|uncontrolled|profuse\w*|keeps?|won'?t stop|wont stop|"
    r"can'?t stop|not stopping|pouring|gushing)\b[\w\s]{0,20}?\bbleed\w*\b"
    r"|\bbleed\w*\b[\w\s]{0,20}?\b(won'?t|wont|doesn'?t|does not|isn'?t|not) stop\w*\b"
    r"|\bbleed\w*\b[\w\s]{0,10}?\b(heavily|a lot|non-?stop)\b",
    re.I,
)

TRAUMA = re.compile(
    r"\b(knocked[- ]out|knocked out|broken jaw|jaw (is )?broken|fractured jaw|dislocated jaw)\b"
    r"|\b(hit|fell|fall(en)?|accident|punched|crash\w*|injur\w*|trauma|blow)\b[\w\s,]{0,30}?\b(face|jaw|mouth|teeth|tooth|head)\b"
    r"|\b(face|jaw|mouth|teeth|tooth)\b[\w\s,]{0,30}?\b(hit|accident|injur\w*|trauma|smashed|cracked open)\b",
    re.I,
)
SPREADING = re.compile(
    r"\bswell\w*\b[\w\s]{0,30}?\b(eye|neck|throat)\b|\b(eye|neck|throat)\b[\w\s]{0,15}?\bswell\w*", re.I
)


@dataclass
class SafetyResult:
    triggered: bool = False
    rules: list[str] = field(default_factory=list)
    breathing_or_swallowing: bool = False

    @property
    def instruction(self) -> str:
        if not self.triggered:
            return ""
        extra = (
            " Breathing or swallowing is affected: tell them to go to the nearest hospital emergency department now."
            if self.breathing_or_swallowing
            else " If breathing or swallowing becomes difficult, they must go to the nearest hospital emergency department."
        )
        return (
            f"URGENT (safety rule triggered: {', '.join(self.rules)}): follow the emergency protocol. "
            "Do not diagnose and do not suggest any medicine. Say calmly that this may be serious. "
            "Call escalate_to_human with urgency='urgent' now, then tell the patient a staff member will call them shortly."
            + extra
        )


def check_message(text: str) -> SafetyResult:
    t = " ".join(text.split())
    rules: list[str] = []
    if SWELLING.search(t) and FEVER.search(t):
        rules.append("swelling_with_fever")
    breath = bool(BREATH_SWALLOW.search(t) or SHORT_OF_BREATH.search(t))
    if breath:
        rules.append("breathing_or_swallowing")
    if SPREADING.search(t):
        rules.append("spreading_swelling")
    if BLEEDING.search(t):
        rules.append("heavy_bleeding")
    if TRAUMA.search(t):
        rules.append("facial_trauma")
    return SafetyResult(triggered=bool(rules), rules=rules, breathing_or_swallowing=breath)
