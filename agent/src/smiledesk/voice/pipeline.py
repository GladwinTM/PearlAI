"""The Pipecat voice pipeline.

  transport.input → Whisper STT → VoiceGuard → user aggregator (Silero VAD, interruptions)
    → LLM (OpenAI-compatible, same prompt + tools as chat) → Kokoro TTS → transport.output → assistant aggregator

Tool logic is NOT duplicated: Pipecat function handlers call agent.tools.execute_tool, the same executors chat and
evals use (with the same guards: offered-slot booking, caller-given phone numbers, identified-patient writes).
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

from loguru import logger
from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import EndFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    AssistantTurnStoppedMessage,
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
    UserTurnStoppedMessage,
)
from pipecat.processors.aggregators.llm_text_processor import LLMTextProcessor
from pipecat.processors.frameworks.rtvi import RTVIProcessor
from pipecat.processors.frameworks.rtvi.frames import RTVIServerMessageFrame
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import BaseTransport, TransportParams

from smiledesk.agent import logging as convlog
from smiledesk.agent.clinic import load_clinic
from smiledesk.agent.core import store
from smiledesk.agent.personas import caller_phone_for
from smiledesk.agent.prompts import render
from smiledesk.agent.tools import TOOL_SCHEMAS, ToolContext, assistant_text_before_last_user, execute_tool
from smiledesk.clock import now
from smiledesk.config import Settings, get_settings
from smiledesk.providers.llm import get_llm_client, llm_extra_body
from smiledesk.providers.stt import get_stt
from smiledesk.providers.tts import get_tts
from smiledesk.voice.events import LatencyObserver, VoiceGuard, VoiceSession, strip_notes
from smiledesk.voice.text import SAFE_REPLACEMENT, ClaimGuard, FirstClauseAggregator, strip_for_speech

FILLER = "One moment, let me check."
RESUME_GREETING = "Hi, it's Pearl. I have our chat in front of me, so go ahead."
WRITE_TOOLS = {"book_appointment", "reschedule_appointment", "cancel_appointment"}


# ── Transport factory (the only place that knows which transport is used) ──


def create_transport(connection: Any, settings: Settings | None = None) -> BaseTransport:
    s = settings or get_settings()
    params = TransportParams(audio_in_enabled=True, audio_out_enabled=True)
    if s.voice_transport == "smallwebrtc":
        from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

        return SmallWebRTCTransport(webrtc_connection=connection, params=params)
    if s.voice_transport == "daily":  # pragma: no cover - deployment option, see docs/DEPLOY.md
        raise NotImplementedError("VOICE_TRANSPORT=daily is planned for deployment (M6); use smallwebrtc locally.")
    raise ValueError(f"Unknown VOICE_TRANSPORT: {s.voice_transport}")


def tools_schema() -> ToolsSchema:
    return ToolsSchema(
        standard_tools=[
            FunctionSchema(
                name=t["function"]["name"],
                description=t["function"]["description"],
                properties=t["function"]["parameters"]["properties"],
                required=t["function"]["parameters"].get("required", []),
            )
            for t in TOOL_SCHEMAS
        ]
    )


class _SharedClientLLMService(OpenAILLMService):
    """Pipecat's OpenAI service on our shared client, so voice gets the same model fallback as chat."""

    def create_client(
        self,
        api_key: Any = None,
        base_url: Any = None,
        organization: Any = None,
        project: Any = None,
        default_headers: Any = None,
        **kwargs: Any,
    ) -> Any:
        return get_llm_client()


def create_llm(s: Settings) -> OpenAILLMService:
    return _SharedClientLLMService(
        api_key=s.llm_api_key.get_secret_value() or "unused",
        base_url=s.llm_base_url,
        settings=OpenAILLMService.Settings(
            model=s.llm_request_model,
            temperature=s.llm_temperature,
            extra={"extra_body": llm_extra_body(s)},
        ),
    )


# ── Session ─────────────────────────────────────────────────────

active_sessions: dict[str, VoiceSession] = {}


def _plain_history(messages: list[Any]) -> list[dict[str, Any]]:
    """OpenAI-format user/assistant/tool messages (no system prompt), safe to hand between chat and voice."""
    out: list[dict[str, Any]] = []
    for m in messages:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant", "tool"):
            out.append(json.loads(json.dumps(m, default=str)))
    return out


async def run_voice_session(connection: Any, persona: str | None = None, conversation_id: str | None = None) -> None:
    """Build and run one call. Returns when the call ends (hang-up, time limit or error).

    With `conversation_id` the call continues that conversation (e.g. the caller switched from chat to voice): same
    id, same ToolContext (patient handles, offered slots), and the chat history seeded into the LLM context. When the
    call ends its turns are written back, so chat can carry on after voice too.
    """
    s = get_settings()
    session_key = uuid.uuid4().hex
    clinic = await asyncio.to_thread(load_clinic)
    conv = await store.get_or_create(conversation_id, persona=persona, channel="voice")
    if conv.id is None:  # pragma: no cover - only when logging is off
        raise RuntimeError("voice sessions need a logged conversation")
    conversation_id = conv.id
    resumed = bool(conv.messages)
    ctx: ToolContext = conv.ctx
    previous_channel = ctx.channel
    ctx.channel = "voice"  # bookings made during the call are tagged as voice
    session = VoiceSession(conversation_id=conversation_id, ctx=ctx, vad_stop_secs=s.voice_vad_stop_secs)
    active_sessions[session_key] = session

    transport = create_transport(connection, s)
    stt = get_stt().pipecat_service()
    tts = get_tts().pipecat_service()
    llm = create_llm(s)

    messages: list[dict[str, Any]] = [{"role": "system", "content": render(s.prompt_version, clinic, now())}]
    messages += _plain_history(conv.messages)
    context = LLMContext(messages=messages, tools=tools_schema())  # pyright: ignore[reportArgumentType]
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=s.voice_vad_stop_secs))
        ),
    )
    rtvi = RTVIProcessor()

    worker: PipelineWorker | None = None

    async def send(data: dict[str, Any]) -> None:
        if worker is not None:
            await worker.queue_frame(RTVIServerMessageFrame(data=data))

    guard = VoiceGuard(session, send)

    # ── tools: shared executors, plus Inspector events + a spoken filler ──
    async def handle_tool(params: FunctionCallParams) -> None:
        name, args = params.function_name, dict(params.arguments)
        await send({"type": "tool_call", "id": params.tool_call_id, "name": name, "args": args})
        if not session.spoke_this_turn and not session.filler_done:
            # Locally a tool round (tool + the follow-up LLM call) always takes well over 700 ms, so say something now
            # rather than leave dead air. Only once per turn, and only if Pearl hasn't already said "let me check".
            session.filler_done = True
            await params.llm.push_frame(TTSSpeakFrame(FILLER))
        # Writes need Pearl's previous line to have been a confirmation question naming that slot.
        ctx.last_assistant_text = assistant_text_before_last_user(context.get_messages())
        result, ms = await execute_tool(name, args, ctx)
        if name in WRITE_TOOLS and "error" not in result:
            session.last_write_turn = session.turn_index
        await send({"type": "tool_result", "id": params.tool_call_id, "name": name, "result": result, "ms": ms})
        await convlog.log_message(
            conversation_id, "tool", tool_name=name, tool_args=args, tool_result=result, latency_ms=ms
        )
        await params.result_callback(result)

    for t in TOOL_SCHEMAS:
        llm.register_function(t["function"]["name"], handle_tool)

    async def on_claim_blocked(sentence: str) -> None:
        logger.warning(f"[voice] blocked an unbacked action claim: {sentence!r}")
        await send({"type": "claim_blocked", "text": sentence, "replacement": SAFE_REPLACEMENT})

    # Sentence-level rewrites before TTS: they change what is spoken, logged and remembered alike.
    text_processor = LLMTextProcessor(
        text_aggregator=FirstClauseAggregator(),
        text_transforms=[("*", strip_for_speech), ("*", ClaimGuard(session.wrote_recently, on_claim_blocked))],
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            guard,
            aggregators.user(),
            llm,
            text_processor,
            tts,
            transport.output(),
            aggregators.assistant(),
        ]
    )
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        rtvi_processor=rtvi,
        observers=[LatencyObserver(session, send)],
        idle_timeout_secs=s.max_voice_session_seconds,
    )

    # ── logging ──
    @aggregators.user().event_handler("on_user_turn_stopped")
    async def _on_user_turn(_agg: Any, _strategy: Any, message: UserTurnStoppedMessage) -> None:
        await convlog.log_message(conversation_id, "user", strip_notes(message.content or ""))

    @aggregators.assistant().event_handler("on_assistant_turn_stopped")
    async def _on_assistant_turn(_agg: Any, message: AssistantTurnStoppedMessage) -> None:
        if message.content.strip():
            last = session.latencies[-1]["voice_to_voice_ms"] if session.latencies else None
            await convlog.log_message(conversation_id, "assistant", message.content, latency_ms=last)
        if ctx.outcome:
            await convlog.update_conversation(conversation_id, outcome=ctx.outcome, patient_id=ctx.patient_id)

    # ── greeting + caller ID, once the browser is ready to play audio ──
    @rtvi.event_handler("on_client_ready")
    async def _on_client_ready(_rtvi: Any) -> None:
        await send({"type": "session", "conversation_id": conversation_id, "max_seconds": s.max_voice_session_seconds,
                    "vad_stop_ms": int(s.voice_vad_stop_secs * 1000), "persona": persona})  # fmt: skip
        phone = caller_phone_for(persona)
        if phone and not conv.caller_looked_up:
            conv.caller_looked_up = True
            ctx.allowed_phones.add(phone)
            call_id = f"auto_{uuid.uuid4().hex[:8]}"
            args = {"phone": phone}
            await send({"type": "tool_call", "id": call_id, "name": "lookup_patient", "args": args, "auto": True})
            result, ms = await execute_tool("lookup_patient", args, ctx)
            await send({"type": "tool_result", "id": call_id, "name": "lookup_patient", "result": result, "ms": ms})
            context.add_messages(
                [
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": call_id,
                                "type": "function",
                                "function": {"name": "lookup_patient", "arguments": json.dumps(args)},
                            }
                        ],
                    },
                    {"role": "tool", "tool_call_id": call_id, "content": json.dumps(result)},
                ]
            )  # pyright: ignore[reportArgumentType]
        # A fixed greeting through TTS: no LLM round, so Pearl speaks within ~1 s of connecting.
        await worker.queue_frame(TTSSpeakFrame(RESUME_GREETING if resumed else s.voice_greeting))

    @transport.event_handler("on_client_disconnected")
    async def _on_disconnected(_transport: Any, _client: Any) -> None:
        logger.info(f"[voice] client disconnected ({conversation_id})")
        await worker.cancel(reason="client disconnected")

    async def session_limit() -> None:
        await asyncio.sleep(s.max_voice_session_seconds)
        logger.info(f"[voice] session limit reached ({conversation_id})")
        await send({"type": "session_ending", "reason": "time_limit"})
        await worker.queue_frames(
            [
                TTSSpeakFrame("We've reached the time limit for this demo call. Thanks for calling Pearl Dental Care!"),
                EndFrame(),
            ]
        )

    limiter = asyncio.create_task(session_limit())
    t_start = time.monotonic()
    try:
        await PipelineRunner(handle_sigint=False).run(worker)
    finally:
        limiter.cancel()
        active_sessions.pop(session_key, None)
        # Hand the call back to the shared conversation so chat can continue it.
        conv.messages = _plain_history(context.get_messages())
        ctx.channel = previous_channel
        med = session.median_voice_to_voice()
        logger.info(
            f"[voice] call ended after {time.monotonic() - t_start:.0f}s; turns={len(session.latencies)} "
            f"median voice-to-voice={med} ms; interruptions={session.interruptions}"
        )
        await convlog.update_conversation(conversation_id, outcome=ctx.outcome, patient_id=ctx.patient_id, ended=True)
