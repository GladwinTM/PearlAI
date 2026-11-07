"""Headless voice test: a WebRTC client that *speaks* to Pearl and measures what a caller would experience.

It connects to /api/offer exactly like the browser (SmallWebRTC + RTVI client-ready), speaks each utterance
(synthesized with Kokoro in a different voice), and measures CLIENT-SIDE voice-to-voice latency: from the end of
the caller's audio to the first audible audio from Pearl, so VAD hold time, STT, LLM, TTS and network are all in.

  uv run python scripts/voice_probe.py --persona ravi "I need a checkup next Wednesday afternoon" "The first one" "Yes"
  uv run python scripts/voice_probe.py --barge-in "Do you take insurance"
"""

from __future__ import annotations

import argparse
import asyncio
import fractions
import json
import os
import statistics
import sys
import time
from typing import Any

import httpx
import numpy as np
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from av import AudioFrame

AGENT = os.environ.get("AGENT_URL", "http://localhost:8000")
RATE = 48_000
FRAME = 960  # 20 ms
CALLER_VOICE = "am_michael"
SPEECH_RMS = 0.01  # Pearl's audio above this = audible


class CallerTrack(MediaStreamTrack):
    """Outgoing mic: silence, or the queued utterance in real time."""

    kind = "audio"

    def __init__(self) -> None:
        super().__init__()
        self.queue: np.ndarray = np.zeros(0, dtype=np.int16)
        self.pts = 0
        self.t0: float | None = None
        self.speech_ended_at: float | None = None
        self.speaking = False

    def say(self, pcm: np.ndarray) -> None:
        self.queue = np.concatenate([self.queue, pcm])
        self.speaking = True

    async def recv(self) -> AudioFrame:
        if self.t0 is None:
            self.t0 = time.perf_counter()
        target = self.t0 + self.pts / RATE
        delay = target - time.perf_counter()
        if delay > 0:
            await asyncio.sleep(delay)
        chunk = self.queue[:FRAME]
        self.queue = self.queue[FRAME:]
        if len(chunk) < FRAME:
            if self.speaking and len(chunk) == 0:
                self.speaking = False
                self.speech_ended_at = time.perf_counter()
            chunk = np.concatenate([chunk, np.zeros(FRAME - len(chunk), dtype=np.int16)])
        frame = AudioFrame.from_ndarray(chunk.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = RATE
        frame.pts = self.pts
        frame.time_base = fractions.Fraction(1, RATE)
        self.pts += FRAME
        return frame


class Listener:
    """Consumes Pearl's audio and timestamps when she is audible."""

    def __init__(self) -> None:
        self.audible_since: float | None = None
        self.last_audible: float = 0.0
        self.first_audible_after: dict[float, float] = {}

    async def run(self, track: MediaStreamTrack) -> None:
        while True:
            try:
                frame = await track.recv()
            except Exception:
                return
            pcm = frame.to_ndarray().astype(np.float32) / 32768.0  # pyright: ignore[reportAttributeAccessIssue]
            now = time.perf_counter()
            if float(np.sqrt(np.mean(pcm**2))) > SPEECH_RMS:
                self.last_audible = now
                if self.audible_since is None:
                    self.audible_since = now

    def quiet_for(self, secs: float) -> bool:
        return time.perf_counter() - self.last_audible > secs

    async def wait_audible_after(self, t: float, timeout: float = 60) -> float | None:
        end = time.perf_counter() + timeout
        while time.perf_counter() < end:
            if self.last_audible > t:
                return self.last_audible
            await asyncio.sleep(0.01)
        return None


def synth(text: str) -> np.ndarray:
    from pipecat.services.kokoro.tts import KOKORO_CACHE_DIR

    from smiledesk.providers.tts import _shared_kokoro

    k = _shared_kokoro(str(KOKORO_CACHE_DIR / "kokoro-v1.0.onnx"), str(KOKORO_CACHE_DIR / "voices-v1.0.bin"))
    samples, sr = k.create(text, voice=CALLER_VOICE, lang="en-us")
    x = np.interp(np.arange(0, len(samples) * RATE / sr) * sr / RATE, np.arange(len(samples)), samples)
    return (np.clip(x, -1, 1) * 32767 * 0.8).astype(np.int16)


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("turns", nargs="+")
    ap.add_argument("--persona")
    ap.add_argument("--barge-in", action="store_true", help="interrupt Pearl 1.2 s into her last reply")
    a = ap.parse_args()

    print("synthesizing caller audio…", flush=True)
    clips = [synth(t) for t in a.turns]
    interrupt_clip = synth("Sorry, wait a second.") if a.barge_in else None

    pc = RTCPeerConnection()
    caller = CallerTrack()
    pc.addTrack(caller)
    listener = Listener()
    events: list[dict[str, Any]] = []
    bot = {"speaking": False, "changed": time.perf_counter()}
    seen_segments: set[Any] = set()
    channel = pc.createDataChannel("rtvi")

    @channel.on("open")
    def _open() -> None:
        channel.send(json.dumps({"label": "rtvi-ai", "type": "client-ready", "id": "probe-1",
                                 "data": {"version": "2.3.0", "about": {"library": "smiledesk-voice-probe"}}}))  # fmt: skip

    @channel.on("message")
    def _msg(raw: Any) -> None:
        try:
            m = json.loads(raw)
        except (TypeError, ValueError):
            return
        m["_t"] = time.perf_counter()
        events.append(m)
        if m.get("type") in ("bot-started-speaking", "bot-stopped-speaking"):
            bot["speaking"] = m["type"] == "bot-started-speaking"
            bot["changed"] = m["_t"]
        if m.get("type") == "server-message":
            d = m.get("data", {})
            if d.get("type") in ("tool_call", "safety", "latency", "interruption"):
                brief = {k: v for k, v in d.items() if k not in ("instruction", "result")}
                print(f"    [server] {json.dumps(brief)[:220]}", flush=True)
        elif m.get("type") == "user-transcription" and m.get("data", {}).get("final"):
            print(f"    [stt] {m['data']['text']}", flush=True)
        elif m.get("type") == "bot-output" and m.get("data", {}).get("text"):
            seg = m["data"].get("segment_id")
            if seg is None or seg not in seen_segments:  # progress updates repeat a segment
                seen_segments.add(seg)
                print(f"    [pearl] {m['data']['text']}", flush=True)

    @pc.on("track")
    def _track(track: MediaStreamTrack) -> None:
        if track.kind == "audio":
            asyncio.ensure_future(listener.run(track))

    await pc.setLocalDescription(await pc.createOffer())
    async with httpx.AsyncClient(timeout=60) as http:
        r = await http.post(f"{AGENT}/api/offer", json={"sdp": pc.localDescription.sdp, "type": pc.localDescription.type,
                                                         "requestData": {"persona": a.persona}})  # fmt: skip
        r.raise_for_status()
        ans = r.json()
    await pc.setRemoteDescription(RTCSessionDescription(sdp=ans["sdp"], type=ans["type"]))
    t_connected = time.perf_counter()

    greet = await listener.wait_audible_after(t_connected, 30)
    print(f"greeting audible {int((greet - t_connected) * 1000) if greet else '—'} ms after connect", flush=True)
    while not listener.quiet_for(1.2):
        await asyncio.sleep(0.05)

    def latency_rows(answered_only: bool = True) -> list[dict[str, Any]]:
        rows = [
            e["data"]
            for e in events
            if e.get("type") == "server-message" and e.get("data", {}).get("type") == "latency"
        ]
        return [r for r in rows if not (answered_only and r.get("partial"))]

    v2v: list[int] = []
    for i, (text, clip) in enumerate(zip(a.turns, clips, strict=True)):
        print(f"\ncaller: {text}", flush=True)
        before = len(latency_rows())
        caller.say(clip)
        while caller.speaking:
            await asyncio.sleep(0.01)
        ended = caller.speech_ended_at or time.perf_counter()
        heard = await listener.wait_audible_after(ended + 0.05, 90)
        if heard is None:
            print("  ✗ nothing audible within 90 s")
            continue
        ms = int((heard - ended) * 1000)
        v2v.append(ms)
        print(f"  pearl audible after {ms} ms (client-side, may be the filler)", flush=True)
        # Wait until the real answer starts (the server reports it), not just the filler.
        deadline = time.perf_counter() + 120
        while len(latency_rows()) <= before and time.perf_counter() < deadline:
            await asyncio.sleep(0.05)
        t_answer = time.perf_counter()
        if i == len(a.turns) - 1 and interrupt_clip is not None:
            # Barge in only while Pearl is actually speaking her answer.
            while not bot["speaking"] and time.perf_counter() - t_answer < 30:
                await asyncio.sleep(0.02)
            await asyncio.sleep(1.0)
            print("caller interrupts: Sorry, wait a second.", flush=True)
            t_int = time.perf_counter()
            caller.say(interrupt_clip)
            while time.perf_counter() - t_int < 8:
                if listener.quiet_for(0.4) and listener.last_audible > t_int - 0.5:
                    print(
                        f"  ✓ Pearl stopped {int((listener.last_audible - t_int) * 1000)} ms after the caller started talking"
                    )
                    break
                await asyncio.sleep(0.02)
            else:
                print("  ✗ Pearl kept talking over the caller")
        # Done when the server says Pearl stopped speaking and she stays quiet (sentences can have gaps).
        while bot["speaking"] or time.perf_counter() - bot["changed"] < 3.0 or not listener.quiet_for(3.0):
            await asyncio.sleep(0.05)

    lat = latency_rows(answered_only=False)
    print("\n── server-side per-turn breakdown (ms) ──")
    for row in lat:
        print(
            "  "
            + " · ".join(
                f"{k}={row.get(k)}"
                for k in (
                    "partial",
                    "stt_ms",
                    "llm_ttft_ms",
                    "tts_ttfb_ms",
                    "voice_to_voice_ms",
                    "answer_ms",
                    "filler_first",
                    "tool_calls",
                    "vad_stop_ms",
                )
            )
        )
    if v2v:
        print(f"\nclient-side voice-to-voice (first audible): median {int(statistics.median(v2v))} ms, all {v2v}")
    if lat:
        simple = [r["voice_to_voice_ms"] for r in lat if not r.get("tool_calls") and not r.get("partial")]
        answers = [r["answer_ms"] for r in lat if r.get("answer_ms") is not None]
        if simple:
            print(
                f"server-side voice-to-voice, turns without tools: median {int(statistics.median(simple))} ms, all {simple}"
            )
        if answers:
            print(f"server-side time to the actual answer: median {int(statistics.median(answers))} ms, all {answers}")
    await pc.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
