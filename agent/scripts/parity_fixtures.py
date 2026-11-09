"""Reference outputs from the Python agent for the TypeScript port's parity tests (web/lib/agent/*.test.ts).

Run against LOCAL Supabase after changing prompts, clock, grounding, safety or voice-text logic:
    cd agent && PYTHONPATH=src SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY= uv run python scripts/parity_fixtures.py
"""

from __future__ import annotations

import asyncio
import json
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from smiledesk.agent.clinic import load_clinic
from smiledesk.agent.grounding import spoken_times
from smiledesk.agent.prompts import render
from smiledesk.agent.safety import check_message
from smiledesk.agent.tools import normalize_phone, phones_in_text
from smiledesk.clock import date_context
from smiledesk.voice.text import is_action_claim, speakable_numbers, speakable_times, strip_for_speech

TZ = ZoneInfo("Asia/Kolkata")
OUT = Path(__file__).resolve().parents[2] / "web/lib/agent/__fixtures__/parity.json"

NOWS = [
    "2026-11-07T17:30:00",
    "2026-11-09T09:05:00",
    "2026-12-31T23:10:00",
    "2027-01-03T00:30:00",
    "2026-11-12T12:00:00",
]
WORKING = {0: [], 1: ["Arjun", "Priya"], 2: ["Kavya", "Priya"], 3: ["Arjun", "Priya"], 4: ["Kavya", "Priya"],
           5: ["Arjun", "Priya"], 6: ["Arjun", "Priya"]}  # fmt: skip
CLOSED = frozenset({date(2026, 12, 25)})

SPOKEN = [
    "I have 9 AM, 10:30 AM or 3 PM.", "ten thirty a.m. works", "How about twelve pm?", "at 9:00 pm or 9 p.m.",
    "Room 12 and 14:00", "nine o'clock AM", "Shall I book Fri 13 Nov at 9:00 AM with Dr. Priya?", "13 PM nope",
    "forty five", "two forty-five p.m.", "",
]  # fmt: skip
SAFETY = [
    "My face is swollen and I have a fever", "swollen gum, no fever", "I can't breathe properly", "bleeding won't stop",
    "I fell and hit my face", "my cheek is swelling up to my eye", "I have toothache", "heavy bleeding after extraction",
    "swelling but I don't have fever", "difficulty swallowing since morning",
]  # fmt: skip
PHONES = [
    "98000 00001",
    "09800000001",
    "+91-98000-00001",
    "919800000002",
    "12345",
    "5800000001",
    "0919800000001",
    None,
    "",
]
TEXT_PHONES = ["call me on 98000 00001 or +91 98000 00002", "my number is 9800000003.", "no number here", "PIN 641001"]
SPEAK = ["I have 12:00 PM or 12:30 PM.", "How about 9:05 am?", "Is 2:00pm okay", "We open at 9:00.", "at 14:00 tomorrow",
         "at 9:30 p.m. today", "Call 98765 43210", "Room 3:2 ratio 12:345"]  # fmt: skip
NUMBERS = ["Is your number 98000 00001?", "Call +919800000001 now", "+91 98000 00002", "ending 0001.", "₹1,200 and 2026",
           "9:30 AM", "Room 12, 3 people", "9800000003", "on 2026-11-12 please"]  # fmt: skip
STRIP = ["Have a great day! 😊", "**Dr. Priya** is free at `10 AM`", "- nine AM\n- ten AM", "1. first\n2. second"]
CLAIMS = ["Your appointment is booked for Friday.", "I've cancelled it for you.", "Dr. Priya is fully booked on Thursday.",
          "That's confirmed!", "Shall I book it?", "Thursday is booked up.", "You're all set for 9 AM."]  # fmt: skip


async def main() -> None:
    clinic = load_clinic(force=True)
    out = {
        "date_context": [
            {"now": n, "text": date_context(datetime.fromisoformat(n).replace(tzinfo=TZ), WORKING, CLOSED)}
            for n in NOWS
        ],
        "render_v2": {"now": NOWS[1], "text": render("v2", clinic, datetime.fromisoformat(NOWS[1]).replace(tzinfo=TZ))},
        "spoken_times": [{"text": t, "times": sorted(spoken_times(t))} for t in SPOKEN],
        "safety": [
            {
                "text": t,
                "rules": (r := check_message(t)).rules,
                "breathing": r.breathing_or_swallowing,
                "instruction": r.instruction,
            }
            for t in SAFETY
        ],
        "normalize_phone": [{"raw": p, "e164": normalize_phone(p)} for p in PHONES],
        "phones_in_text": [{"text": t, "phones": sorted(phones_in_text(t))} for t in TEXT_PHONES],
        "speakable_times": [{"text": t, "spoken": await speakable_times(t)} for t in SPEAK],
        "speakable_numbers": [{"text": t, "spoken": await speakable_numbers(t)} for t in NUMBERS],
        "strip_for_speech": [{"text": t, "spoken": await strip_for_speech(t)} for t in STRIP],
        "action_claims": [{"text": t, "claim": is_action_claim(t)} for t in CLAIMS],
    }
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUT}")


asyncio.run(main())
