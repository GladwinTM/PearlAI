"""Sentence-level text transforms between the LLM and TTS (registered on Pipecat's LLMTextProcessor).

Spoken words can't be retracted like chat text, so these run BEFORE synthesis. Because they sit before the
assistant context aggregator, the model's own history records what was actually said.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from pipecat.utils.text.base_text_aggregator import Aggregation, TextType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

_EMOJI = re.compile("[\U0001f000-\U0001faff\U00002600-\U000027bf\U0001f900-\U0001f9ff\U00002b00-\U00002bff️‍]+")
_MARKDOWN = re.compile(r"(\*\*|\*|__|`+|#{1,6}\s|^\s*[-•]\s+|^\s*\d+\.\s+)", re.M)

# A claim that the CALLER's appointment changed. "Dr. Priya is fully booked" is an availability fact, not a claim.
_CLAIM = re.compile(
    r"\b(i'?ve|i have|we'?ve|we have|you'?re|you are|your\b[^.?!]{0,60}?\b(?:is|has been|are|was)|that'?s|it'?s|all set)\b"
    r"[^.?!]{0,60}?\b(booked|confirmed|cancel+ed|rescheduled|moved)\b",
    re.I,
)
_NOT_A_CLAIM = re.compile(
    r"\b(fully booked|booked up|already booked by|is booked (?:on|for) (?:that|the whole))\b", re.I
)
SAFE_REPLACEMENT = "Shall I go ahead and confirm that for you?"


async def strip_for_speech(text: str, _text_type: Any = None) -> str:
    """No emoji, markdown or list markers reach the voice (the prompt asks; this guarantees)."""
    out = _MARKDOWN.sub("", _EMOJI.sub("", text))
    return re.sub(r"[ \t]{2,}", " ", out)


def is_action_claim(sentence: str) -> bool:
    return bool(_CLAIM.search(sentence)) and not _NOT_A_CLAIM.search(sentence)


class ClaimGuard:
    """Replaces "your appointment is booked/cancelled/moved" when no write tool actually succeeded recently.

    `wrote_recently()` is true if book/reschedule/cancel succeeded in this caller turn or the previous one
    (so a recap right after a real booking is allowed).
    """

    def __init__(self, wrote_recently: Callable[[], bool], on_block: Callable[[str], Awaitable[None]]) -> None:
        self.wrote_recently = wrote_recently
        self.on_block = on_block

    async def __call__(self, text: str, _text_type: Any = None) -> str:
        if is_action_claim(text) and not self.wrote_recently():
            await self.on_block(text)
            return SAFE_REPLACEMENT
        return text


class FirstClauseAggregator(SimpleTextAggregator):
    """Sentence aggregation, except the FIRST chunk of each response may end at a comma.

    TTS can't start until it has a chunk. With a local LLM at ~25 tok/s, a long first sentence ("Next Wednesday
    afternoon I have twelve PM, twelve thirty PM or two PM with Dr. Arjun.") costs seconds of silence. Releasing
    the first clause (≥ 4 words) lets Kokoro start speaking while the LLM is still writing; later chunks stay
    sentence-sized so prosody remains natural.
    """

    MIN_WORDS = 4

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._emitted_in_response = False

    async def aggregate(self, text: str) -> AsyncIterator[Aggregation]:
        for char in text:
            if self._emitted_in_response or char != ",":
                async for agg in super().aggregate(char):
                    self._emitted_in_response = True
                    yield agg
                continue
            prev = self._text[-1:] if self._text else ""
            self._text += char
            if not prev.isdigit() and len(self._text.split()) >= self.MIN_WORDS:
                clause, self._text = self._text.strip(" "), ""
                self._emitted_in_response = True
                yield Aggregation(text=clause, type=TextType.SENTENCE)

    async def flush(self) -> Aggregation | None:
        self._emitted_in_response = False
        return await super().flush()

    async def handle_interruption(self) -> None:
        self._emitted_in_response = False
        await super().handle_interruption()

    async def reset(self) -> None:
        self._emitted_in_response = False
        await super().reset()
