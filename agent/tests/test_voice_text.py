"""Voice text transforms: emoji/markdown stripping and the action-claim guard."""

from __future__ import annotations

import pytest

from smiledesk.voice.text import SAFE_REPLACEMENT, ClaimGuard, is_action_claim, strip_for_speech


async def test_strip_for_speech() -> None:
    assert await strip_for_speech("Have a great day! 😊") == "Have a great day! "
    assert await strip_for_speech("**Dr. Priya** is free at `10 AM`") == "Dr. Priya is free at 10 AM"
    assert await strip_for_speech("- nine AM\n- ten AM") == "nine AM\nten AM"


@pytest.mark.parametrize(
    "s",
    [
        "I have booked your checkup with Dr. Arjun on Wed 11 Nov at 12:00 PM.",
        "You're all set, your cleaning is confirmed for Friday.",
        "Your appointment has been cancelled.",
        "It's rescheduled to Friday at nine AM.",
        "I've moved your appointment to Monday.",
    ],
)
def test_claims(s: str) -> None:
    assert is_action_claim(s)


@pytest.mark.parametrize(
    "s",
    [
        "Dr. Priya is fully booked next Thursday.",
        "Would you like me to book the twelve PM slot?",
        "Shall I cancel it?",
        "Next Wednesday I have twelve PM or two PM with Dr. Arjun.",
        "Before booking, can I confirm the time?",
    ],
)
def test_not_claims(s: str) -> None:
    assert not is_action_claim(s)


async def test_claim_guard_blocks_only_without_a_recent_write() -> None:
    blocked: list[str] = []

    async def on_block(t: str) -> None:
        blocked.append(t)

    wrote = False
    guard = ClaimGuard(lambda: wrote, on_block)
    claim = "I have booked your checkup for Wednesday."
    assert await guard(claim) == SAFE_REPLACEMENT
    assert blocked == [claim]
    wrote = True
    assert await guard(claim) == claim
    assert await guard("Dr. Priya is fully booked.") == "Dr. Priya is fully booked."


async def _chunks(agg: object, text: str) -> list[str]:
    out = []
    for tok in text.split(" "):
        async for a in agg.aggregate(tok + " "):  # pyright: ignore[reportAttributeAccessIssue]
            out.append(a.text)
    final = await agg.flush()  # pyright: ignore[reportAttributeAccessIssue]
    if final and final.text.strip():
        out.append(final.text.strip())
    return out


async def test_first_clause_aggregator() -> None:
    from smiledesk.voice.text import FirstClauseAggregator

    agg = FirstClauseAggregator()
    text = (
        "Next Wednesday afternoon I have twelve PM, twelve thirty PM or two PM with Dr. Arjun. Which suits you, Ravi?"
    )
    assert await _chunks(agg, text) == [
        "Next Wednesday afternoon I have twelve PM,",
        "twelve thirty PM or two PM with Dr. Arjun.",
        "Which suits you, Ravi?",
    ]
    # short lead-ins and numbers don't split; the next response gets a fresh first chunk
    assert await _chunks(agg, "Sure, a cleaning costs ₹1,200 at our clinic. Anything else?") == [
        "Sure, a cleaning costs ₹1,200 at our clinic.",
        "Anything else?",
    ]
