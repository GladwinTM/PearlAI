"""Voice-session state, per-turn latency measurement, and the safety/transcript guard.

Events reach the browser as RTVI server messages with the SAME shapes the chat SSE stream uses
(tool_call, tool_result, safety, ...) plus `latency`, so one Inspector component can render both.
"""

from __future__ import annotations

import re
import statistics
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    FunctionCallInProgressFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from smiledesk.agent import logging as convlog
from smiledesk.agent.safety import check_message
from smiledesk.agent.tools import ToolContext, execute_tool, phones_in_text

Send = Callable[[dict[str, Any]], Awaitable[None]]
_NOTE = re.compile(r"\s*\[Clinic system note.*?\]\s*$", re.S)


def strip_notes(text: str | None) -> str:
    return _NOTE.sub("", text or "").strip()


@dataclass
class VoiceSession:
    conversation_id: str | None
    ctx: ToolContext
    vad_stop_secs: float
    started_at: float = field(default_factory=time.monotonic)
    # per-turn flags (reset when the caller stops speaking)
    spoke_this_turn: bool = False
    filler_done: bool = False
    turn_t0: float | None = None
    turn_marks: dict[str, float] = field(default_factory=dict)
    turn_tool_calls: int = 0
    bot_speaking: bool = False
    turn_index: int = 0
    last_write_turn: int = -10  # turn in which book/reschedule/cancel last succeeded

    def wrote_recently(self) -> bool:
        return self.turn_index - self.last_write_turn <= 1

    # results
    latencies: list[dict[str, Any]] = field(default_factory=list)
    interruptions: int = 0

    def median_voice_to_voice(self) -> int | None:
        vals = [x["voice_to_voice_ms"] for x in self.latencies if x.get("voice_to_voice_ms") is not None]
        return int(statistics.median(vals)) if vals else None


class LatencyObserver(BaseObserver):
    """Timestamps each turn from the caller going quiet to Pearl's audio.

    t0 = VAD confirms the caller stopped (VOICE_VAD_STOP_SECS after their last word; reported separately).
      stt_ms          final transcript
      llm_ttft_ms     first token of the LLM response that produced Pearl's answer (after any tool rounds)
      tts_ttfb_ms     first answer audio after that first token (includes sentence aggregation)
      voice_to_voice  Pearl audible at all (may be the "one moment" filler)
      answer_ms       the actual answer starts playing
    """

    def __init__(self, session: VoiceSession, send: Send) -> None:
        super().__init__()
        self.s = session
        self.send = send
        self._tool_ids: set[str] = set()
        self._reported = True

    def _mark(self, key: str) -> None:
        if self.s.turn_t0 is not None and key not in self.s.turn_marks:
            self.s.turn_marks[key] = time.perf_counter()

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        # Pipecat broadcasts some frames (e.g. VAD start/stop) both upstream and downstream as separate copies;
        # count each event once.
        if not data.first_push or data.direction != FrameDirection.DOWNSTREAM:
            return
        s, m = self.s, self.s.turn_marks
        if isinstance(frame, VADUserStartedSpeakingFrame):
            if s.bot_speaking:
                s.interruptions += 1
                await self.send({"type": "interruption", "count": s.interruptions})
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            if s.turn_t0 is not None and not self._reported and "llm_start" not in s.turn_marks:
                # A pause mid-sentence: same turn. Restart the clock from the caller's latest stop.
                s.turn_t0 = time.perf_counter()
                s.turn_marks.pop("stt", None)
                return
            if not self._reported and s.turn_t0 is not None:
                await self._report(partial=True)  # Pearl had started working but never answered (talked over)
            s.turn_t0 = time.perf_counter()
            s.turn_index += 1
            s.turn_marks = {}
            s.spoke_this_turn = False
            s.filler_done = False
            self._tool_ids = set()
            self._reported = False
        elif isinstance(frame, TranscriptionFrame):
            self._mark("stt")
        elif isinstance(frame, LLMFullResponseStartFrame):
            if s.turn_t0 is not None and "llm_first_token" not in m:
                m["llm_start"] = time.perf_counter()  # the response that eventually speaks
        elif isinstance(frame, LLMTextFrame):
            self._mark("llm_first_token")
            s.spoke_this_turn = True
        elif isinstance(frame, FunctionCallInProgressFrame):
            self._tool_ids.add(frame.tool_call_id)
        elif isinstance(frame, TTSAudioRawFrame):
            if "llm_first_token" in m and "answer_audio" not in m:
                self._mark("answer_audio")
                await self._report()
        elif isinstance(frame, BotStartedSpeakingFrame):
            s.bot_speaking = True
            self._mark("bot_started")
        elif isinstance(frame, BotStoppedSpeakingFrame):
            s.bot_speaking = False

    async def _report(self, partial: bool = False) -> None:
        if self._reported or self.s.turn_t0 is None:
            return
        self._reported = True
        s, m, t0 = self.s, self.s.turn_marks, self.s.turn_t0
        if partial:
            row_p = {"type": "latency", "partial": True, "stt_ms": int((m["stt"] - t0) * 1000) if "stt" in m else None,
                     "tool_calls": len(self._tool_ids), "vad_stop_ms": int(s.vad_stop_secs * 1000)}  # fmt: skip
            s.latencies.append(row_p)
            await self.send(row_p)
            return

        def ms(a: str | None, b: str) -> int | None:
            start = t0 if a is None else m.get(a)
            return int((m[b] - start) * 1000) if start is not None and b in m else None

        first = min(m.get("bot_started", m["answer_audio"]), m["answer_audio"])
        row = {
            "type": "latency",
            "stt_ms": ms(None, "stt"),
            "llm_ttft_ms": ms("llm_start", "llm_first_token"),
            "tts_ttfb_ms": ms("llm_first_token", "answer_audio"),
            "voice_to_voice_ms": int((first - t0) * 1000),
            "answer_ms": ms(None, "answer_audio"),
            "filler_first": first < m["llm_first_token"],
            "tool_calls": len(self._tool_ids),
            "vad_stop_ms": int(s.vad_stop_secs * 1000),
        }
        s.latencies.append(row)
        logger.info(f"[voice latency] {row}")
        await self.send(row)


class VoiceGuard(FrameProcessor):
    """Sits between STT and the user aggregator.

    - remembers phone numbers the caller actually said (lookup_patient only accepts those)
    - runs the red-flag safety backstop on every final transcript; on a hit it escalates deterministically
      and attaches a clinic-system note to the user's turn (qwen3 drops mid-chat system messages)
    """

    def __init__(self, session: VoiceSession, send: Send) -> None:
        super().__init__()
        self.s = session
        self.send = send
        self._escalated = False

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and direction == FrameDirection.DOWNSTREAM and frame.text.strip():
            self.s.ctx.allowed_phones |= phones_in_text(frame.text)
            res = check_message(frame.text)
            if res.triggered:
                await self.send({"type": "safety", "rules": res.rules, "instruction": res.instruction})
                if not self._escalated:
                    self._escalated = True
                    call_id = f"auto_{uuid.uuid4().hex[:8]}"
                    args = {
                        "reason": f"Safety backstop (voice): {', '.join(res.rules)}. Caller said: {frame.text[:200]}",
                        "urgency": "urgent",
                    }
                    await self.send(
                        {"type": "tool_call", "id": call_id, "name": "escalate_to_human", "args": args, "auto": True}
                    )
                    result, ms = await execute_tool("escalate_to_human", args, self.s.ctx)
                    await self.send(
                        {"type": "tool_result", "id": call_id, "name": "escalate_to_human", "result": result, "ms": ms}
                    )
                    await convlog.log_message(
                        self.s.conversation_id,
                        "tool",
                        tool_name="escalate_to_human",
                        tool_args=args,
                        tool_result=result,
                        latency_ms=ms,
                    )
                ed = (
                    " Breathing or swallowing is affected: tell them to go to the nearest hospital emergency department now."
                    if res.breathing_or_swallowing
                    else " If breathing or swallowing gets difficult, they must go to the nearest hospital emergency department."
                )
                frame.text = (
                    f"{frame.text}\n\n[Clinic system note, not from the caller: red-flag symptoms ({', '.join(res.rules)}). "
                    "Staff have ALREADY been alerted as urgent and will call within 15 minutes; do not call escalate_to_human again. "
                    "Calmly say this may be serious and that a staff member will call within 15 minutes. "
                    f"Do not diagnose or suggest any medicine.{ed}]"
                )
        await self.push_frame(frame, direction)
