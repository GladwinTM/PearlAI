"""The tool-calling loop used by chat and evals (voice reuses the same prompt, schemas and executors via Pipecat).

run_turn(conversation, user_text) streams events:
  safety       {rules, instruction}                       red-flag backstop fired (before the LLM)
  token        {text}                                     streamed assistant text
  tool_call    {id, name, args, auto?}                    model (or the safety backstop) called a tool
  tool_result  {id, name, result, ms}
  retract      {text, reason, times}                      streamed text failed the grounding check; UI strikes it
  done         {text, outcome, timings}
  error        {message}
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, cast

from loguru import logger
from openai import APIConnectionError, APIError, APITimeoutError

from smiledesk.agent import logging as convlog
from smiledesk.agent.clinic import load_clinic
from smiledesk.agent.grounding import spoken_times, times_in, ungrounded
from smiledesk.agent.personas import caller_phone_for
from smiledesk.agent.prompts import render
from smiledesk.agent.safety import SafetyResult, check_message
from smiledesk.agent.tools import (
    TOOL_SCHEMAS,
    ToolContext,
    assistant_text_before_last_user,
    execute_tool,
    phones_in_text,
)
from smiledesk.clock import now
from smiledesk.config import Settings, get_settings
from smiledesk.providers.llm import get_llm_client, llm_extra_body

MAX_TOOL_ROUNDS = 5
# "Let me check… one moment" with no tool call: small models announce actions instead of taking them.
_ANNOUNCED_ACTION = re.compile(
    r"\b(let me|i'll|i will|i'm going to|allow me to|i am going to)\s+(quickly\s+)?(check|look|see|find|search|book|confirm)"
    r"|\bone moment\b|\bjust a moment\b|\bplease hold\b|\bchecking (now|that|availability)\b",
    re.I,
)
NUDGE = (
    "[Clinic system note, not from the patient: you said you would check. Call the right tool now instead of replying.]"
)


# Questions whose answer must come from the FAQ (get_clinic_info), never from the model's memory.
_FACT_QUESTION = re.compile(
    r"\b(insurance|insured|insurer|price|prices|pricing|cost|costs|how much|fee|fees|charges?|payment|pay (by|with|in)"
    r"|cards?|upi|cash|emi|parking|park\b|address|located|location|directions|where (are|is) (you|the clinic)"
    r"|opening hours|what time do you (open|close)|are you open|policy|policies|aftercare|invisalign|aligners?)\b",
    re.I,
)
NUDGE_FACTS = (
    "[Clinic system note, not from the patient: that is a question about the clinic. Call get_clinic_info with it now "
    "and answer only from what it returns.]"
)


def _nudge_ungrounded(times: set[str]) -> str:
    said = ", ".join(sorted(times))
    return (
        f"[Clinic system note, not from the patient: you mentioned {said}, which no tool returned. "
        "Call check_availability now and only offer times it returns. Do not apologise at length.]"
    )


MAX_HISTORY_MESSAGES = 40
Event = dict[str, Any]


# ── LLM adapter (so tests can inject a scripted model) ──────────


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class TextDelta:
    text: str


@dataclass
class Completed:
    tool_calls: list[ToolCall]


class ChatLLM(Protocol):
    model: str

    def stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], tool_choice: str
    ) -> AsyncIterator[TextDelta | Completed]: ...


class _ThinkFilter:
    """Drops <think>…</think> blocks if a model emits reasoning inline despite thinking being off."""

    def __init__(self) -> None:
        self.buf = ""
        self.inside = False

    def feed(self, s: str) -> str:
        self.buf += s
        out = ""
        while self.buf:
            if self.inside:
                end = self.buf.find("</think>")
                if end < 0:
                    self.buf = self.buf[-8:]
                    return out
                self.buf = self.buf[end + 8 :]
                self.inside = False
            else:
                start = self.buf.find("<think>")
                if start < 0:
                    # keep a possible partial tag at the end
                    keep = next(
                        (k for k in range(min(7, len(self.buf)), 0, -1) if "<think>".startswith(self.buf[-k:])), 0
                    )
                    out += self.buf[: len(self.buf) - keep]
                    self.buf = self.buf[len(self.buf) - keep :]
                    return out
                out += self.buf[:start]
                self.buf = self.buf[start + 7 :]
                self.inside = True
        return out

    def flush(self) -> str:
        out = "" if self.inside else self.buf
        self.buf = ""
        return out


def recover_failed_tool_call(e: APIError) -> ToolCall | None:
    body = e.body if isinstance(e.body, dict) else {}
    err = body.get("error", body) if isinstance(body, dict) else {}
    if not isinstance(err, dict) or err.get("code") != "tool_use_failed" or not err.get("failed_generation"):
        return None
    try:
        g = json.loads(err["failed_generation"])
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(g, dict) or g.get("name") not in {t["function"]["name"] for t in TOOL_SCHEMAS}:
        return None
    args = g.get("arguments")
    return ToolCall(
        f"call_{uuid.uuid4().hex[:8]}", g["name"], args if isinstance(args, str) else json.dumps(args or {})
    )


class OpenAIChatLLM:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.model = self.settings.llm_request_model
        self.client = get_llm_client(self.settings)

    async def stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], tool_choice: str
    ) -> AsyncIterator[TextDelta | Completed]:
        try:
            resp = await self.client.chat.completions.create(
                model=self.model,
                messages=cast(Any, messages),
                tools=cast(Any, tools),
                tool_choice=cast(Any, tool_choice),
                temperature=self.settings.llm_temperature,
                stream=True,
                extra_body=llm_extra_body(self.settings),
            )
        except APIError as e:
            # Groq validates tool arguments server-side (e.g. rejects {"patient_id": null}) but returns what the
            # model meant to call: run that instead of failing the turn (null arguments are dropped by execute_tool).
            recovered = recover_failed_tool_call(e)
            if recovered is None:
                raise
            logger.info(f"recovered a tool call the provider rejected: {recovered.name}")
            yield Completed([recovered])
            return
        acc: dict[int, dict[str, str]] = {}
        think = _ThinkFilter()
        async for chunk in resp:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                text = think.feed(delta.content)
                if text:
                    yield TextDelta(text)
            for tc in delta.tool_calls or []:
                slot = acc.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                if tc.id:
                    slot["id"] = tc.id
                if tc.function and tc.function.name:
                    slot["name"] += tc.function.name
                if tc.function and tc.function.arguments:
                    slot["arguments"] += tc.function.arguments
        if rest := think.flush():
            yield TextDelta(rest)
        yield Completed(
            [
                ToolCall(v["id"] or f"call_{uuid.uuid4().hex[:8]}", v["name"], v["arguments"] or "{}")
                for _, v in sorted(acc.items())
            ]
        )


async def prefill_prompt_cache(settings: Settings | None = None) -> None:
    """Process the static system prompt + tool schemas once, so the server's prompt cache is warm for turn one."""
    s = settings or get_settings()
    clinic = await asyncio.to_thread(load_clinic)
    system = render(s.prompt_version, clinic, now())
    await get_llm_client(s).chat.completions.create(
        model=s.llm_request_model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": "Hello"}],
        tools=TOOL_SCHEMAS,  # pyright: ignore[reportArgumentType]
        max_tokens=1,
        extra_body=llm_extra_body(s),
    )


# ── Conversations ───────────────────────────────────────────────


@dataclass
class Conversation:
    id: str | None
    channel: Literal["chat", "voice"] = "chat"
    persona: str | None = None
    prompt_version: str = "v1"
    messages: list[dict[str, Any]] = field(default_factory=list)
    ctx: ToolContext = field(default_factory=ToolContext)
    caller_looked_up: bool = False
    grounded_times: set[str] = field(default_factory=set)  # times Pearl may say: only ones a tool returned
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_used: float = field(default_factory=time.monotonic)

    @property
    def caller_phone(self) -> str | None:
        return caller_phone_for(self.persona)


class ConversationStore:
    """In-memory active conversations; rebuilt from the messages table if the server restarted."""

    def __init__(self, ttl_s: float = 3600) -> None:
        self.ttl_s = ttl_s
        self._items: dict[str, Conversation] = {}

    def _gc(self) -> None:
        cutoff = time.monotonic() - self.ttl_s
        for k in [k for k, c in self._items.items() if c.last_used < cutoff]:
            del self._items[k]

    async def get_or_create(
        self,
        conversation_id: str | None,
        *,
        persona: str | None = None,
        channel: Literal["chat", "voice"] = "chat",
        prompt_version: str | None = None,
        log: bool = True,
    ) -> Conversation:
        self._gc()
        s = get_settings()
        if conversation_id and conversation_id in self._items:
            conv = self._items[conversation_id]
            conv.last_used = time.monotonic()
            return conv
        if conversation_id and log:
            restored = await asyncio.to_thread(_restore, conversation_id, persona)
            if restored:
                self._items[conversation_id] = restored
                return restored
        version = prompt_version or s.prompt_version
        cid = await asyncio.to_thread(convlog.create_conversation, channel, version, s.llm_model) if log else None
        conv = Conversation(id=cid, channel=channel, persona=persona, prompt_version=version)
        conv.ctx = ToolContext(conversation_id=cid, channel=channel)
        if cid:
            self._items[cid] = conv
        return conv


def _restore(conversation_id: str, persona: str | None) -> Conversation | None:
    """Text-only rebuild of an older conversation (e.g. after a server restart).

    Tool handles (P1, A1) aren't restored, so the model re-identifies the caller by phone before any write.
    """
    try:
        meta = convlog.get_conversation(conversation_id)
    except Exception:
        return None
    if not meta:
        return None
    conv = Conversation(
        id=conversation_id, channel=meta["channel"], persona=persona, prompt_version=meta.get("prompt_version") or "v1"
    )
    conv.ctx = ToolContext(conversation_id=conversation_id, channel=meta["channel"])
    for m in convlog.load_messages(conversation_id):
        if m["role"] in ("user", "assistant") and m.get("content"):
            conv.messages.append({"role": m["role"], "content": m["content"]})
    return conv


store = ConversationStore()


# ── The turn loop ───────────────────────────────────────────────


def _trim(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the last N messages, starting at a user message so tool call/result pairs stay intact."""
    if len(history) <= MAX_HISTORY_MESSAGES:
        return history
    tail = history[-MAX_HISTORY_MESSAGES:]
    for i, m in enumerate(tail):
        if m["role"] == "user":
            return tail[i:]
    return tail


def _parse_args(raw: str) -> tuple[dict[str, Any], str | None]:
    try:
        v = json.loads(raw or "{}")
        if isinstance(v, str):  # some models double-encode
            v = json.loads(v)
        return (v, None) if isinstance(v, dict) else ({}, "arguments must be a JSON object")
    except json.JSONDecodeError as e:
        return {}, f"invalid JSON arguments: {e.msg}"


async def run_turn(conv: Conversation, user_text: str, llm: ChatLLM | None = None) -> AsyncIterator[Event]:
    async with conv.lock:
        async for ev in _run_turn(conv, user_text, llm or OpenAIChatLLM()):
            yield ev


async def _run_turn(conv: Conversation, user_text: str, llm: ChatLLM) -> AsyncIterator[Event]:
    t_turn = time.perf_counter()
    conv.last_used = time.monotonic()
    timings: dict[str, Any] = {"llm_calls": [], "tools_ms": 0, "ttft_ms": None, "rounds": 0}

    safety: SafetyResult = check_message(user_text)
    if safety.triggered:
        yield {"type": "safety", "rules": safety.rules, "instruction": safety.instruction}

    conv.messages.append({"role": "user", "content": user_text})
    # What Pearl asked just before this message: writes need it to be a confirmation of that exact slot.
    conv.ctx.last_assistant_text = assistant_text_before_last_user(conv.messages)
    conv.ctx.allowed_phones |= phones_in_text(user_text)
    conv.grounded_times |= spoken_times(user_text)  # echoing the caller's own time ("7 PM isn't free") is fine
    if conv.caller_phone:
        conv.ctx.allowed_phones.add(conv.caller_phone)
    user_idx = len(conv.messages) - 1
    await convlog.log_message(conv.id, "user", user_text)

    clinic = await asyncio.to_thread(load_clinic)
    # Caller ID is handled as data (an automatic lookup below), not prompt text, so the system prompt is identical
    # for every caller and stays in the LLM server's prompt cache.
    system = render(conv.prompt_version, clinic, now())
    called: list[str] = []
    spoken: list[str] = []  # all assistant text this turn, across tool rounds
    notes: list[str] = []  # clinic-system notes attached to this user turn
    last_result: dict[str, Any] = {}
    nudged = False
    final_text = ""
    outcome_before = conv.ctx.outcome

    async def llm_round(tool_choice: str) -> AsyncIterator[Event | Completed]:
        nonlocal final_text
        history = _trim(conv.messages)
        msgs: list[dict[str, Any]] = [{"role": "system", "content": system}]
        turn_notes = ([safety.instruction] if safety.triggered else []) + notes
        for m in history:
            if turn_notes and m is conv.messages[user_idx]:
                # Attached to the user turn: qwen3's Ollama template drops mid-conversation system messages.
                note = f"\n\n[Clinic system note, not from the patient: {' '.join(turn_notes)}]"
                msgs.append({**m, "content": m["content"] + note})
            else:
                msgs.append(m)
        t0 = time.perf_counter()
        first: float | None = None
        text = ""
        async for part in llm.stream(msgs, TOOL_SCHEMAS, tool_choice):
            if isinstance(part, TextDelta):
                if first is None:
                    first = time.perf_counter()
                    if timings["ttft_ms"] is None:
                        timings["ttft_ms"] = int((first - t_turn) * 1000)
                text += part.text
                yield {"type": "token", "text": part.text}
            else:
                timings["llm_calls"].append(
                    {
                        "ms": int((time.perf_counter() - t0) * 1000),
                        "first_token_ms": int((first - t0) * 1000) if first else None,
                        "tool_calls": len(part.tool_calls),
                    }
                )
                final_text = text
                if text.strip():
                    spoken.append(text.strip())
                yield part

    async def run_tool(call: ToolCall, *, auto: bool = False) -> AsyncIterator[Event]:
        args, parse_error = _parse_args(call.arguments)
        yield {"type": "tool_call", "id": call.id, "name": call.name, "args": args, **({"auto": True} if auto else {})}
        if parse_error:
            result, ms = {"error": parse_error, "hint": "Call the tool again with valid JSON arguments."}, 0
        else:
            result, ms = await execute_tool(call.name, args, conv.ctx)
        timings["tools_ms"] += ms
        called.append(call.name)
        conv.grounded_times |= times_in(result)
        last_result.clear()
        last_result.update(result)
        yield {"type": "tool_result", "id": call.id, "name": call.name, "result": result, "ms": ms}
        conv.messages.append(
            {"role": "tool", "tool_call_id": call.id, "content": json.dumps(result, ensure_ascii=False)}
        )
        await convlog.log_message(
            conv.id, "tool", tool_name=call.name, tool_args=args, tool_result=result, latency_ms=ms
        )

    def add_assistant(text: str, calls: list[ToolCall]) -> None:
        # With tool calls, keep content empty: qwen3's template renders content OR tool calls, never both,
        # and losing the calls would orphan the tool results. The text was already streamed to the user.
        msg: dict[str, Any] = {"role": "assistant", "content": "" if calls else (text or "")}
        if calls:
            msg["tool_calls"] = [
                {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments or "{}"}}
                for c in calls
            ]
        conv.messages.append(msg)

    try:
        # Caller ID: like a real front-desk system, look the number up before the model even speaks.
        if conv.caller_phone and not conv.caller_looked_up:
            conv.caller_looked_up = True
            call = ToolCall(f"auto_{uuid.uuid4().hex[:8]}", "lookup_patient", json.dumps({"phone": conv.caller_phone}))
            conv.messages.append(
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {"name": call.name, "arguments": call.arguments},
                        }
                    ],
                }
            )
            async for ev in run_tool(call, auto=True):
                yield ev
            # Known caller: greet by name now; the number is confirmed in the booking question (enforced by
            # book_appointment's guard via ctx.confirm_number), not at the start of the call.
            patients = last_result.get("patients") or []
            if last_result.get("found") and patients and last_result.get("number_ending"):
                first = str(patients[0]["full_name"]).split()[0]
                conv.ctx.confirm_number = str(last_result["number_ending"])
                notes.append(
                    f"Caller ID found {first}. Greet them by name and answer their request. Don't ask for their phone "
                    "number and don't confirm it now: you'll confirm it in the booking question "
                    f'("…, on the number ending {last_result["number_ending"]}?").'
                )

        for rnd in range(MAX_TOOL_ROUNDS + 1):
            timings["rounds"] = rnd + 1
            completed: Completed | None = None
            async for ev in llm_round("auto" if rnd < MAX_TOOL_ROUNDS else "none"):
                if isinstance(ev, Completed):
                    completed = ev
                else:
                    yield ev
            calls = completed.tool_calls if completed else []
            if rnd == MAX_TOOL_ROUNDS:
                calls = []  # hard stop: the model must answer now
            add_assistant(final_text, calls)
            if not calls:
                if rnd < MAX_TOOL_ROUNDS - 1 and not nudged:
                    made_up = ungrounded(final_text, conv.grounded_times)
                    unsourced = bool(_FACT_QUESTION.search(user_text)) and "get_clinic_info" not in called
                    reason, nudge = (
                        ("ungrounded_times", _nudge_ungrounded(made_up))
                        if made_up
                        else ("unsourced_fact", NUDGE_FACTS)
                        if unsourced
                        else ("announced_action", NUDGE)
                        if _ANNOUNCED_ACTION.search(final_text)
                        else (None, None)
                    )
                    if nudge:
                        nudged = True
                        timings["nudged"] = reason
                        logger.info(f"nudge: {reason} {sorted(made_up)}")
                        conv.messages.append({"role": "user", "content": nudge})
                        if reason != "announced_action" and final_text.strip():
                            # Already streamed: tell the UI to strike it, and keep it out of the transcript.
                            if spoken and spoken[-1] == final_text.strip():
                                spoken.pop()
                            yield {
                                "type": "retract",
                                "text": final_text,
                                "reason": reason,
                                "times": sorted(made_up),
                            }
                        continue
                break
            for call in calls:
                async for ev in run_tool(call):
                    yield ev

        if not final_text.strip():
            final_text = "Sorry, I didn't catch that. Could you say it again?"
            spoken.append(final_text)
            conv.messages.append({"role": "assistant", "content": final_text})
            yield {"type": "token", "text": final_text}

    except (APIConnectionError, APITimeoutError) as e:
        logger.error(f"LLM unreachable: {e}")
        yield {"type": "error", "message": "The language model isn't reachable right now. Is Ollama running?"}
    except APIError as e:
        logger.error(f"LLM error: {e}")
        yield {"type": "error", "message": f"The language model returned an error: {e.message}"}

    # Safety backstop: if a red flag fired and the model didn't escalate (or the model failed), escalate
    # deterministically. Outside the try on purpose: an LLM error must never skip it.
    if safety.triggered and "escalate_to_human" not in called:
        logger.warning("safety rule fired but the model did not escalate; escalating automatically")
        call = ToolCall(
            f"auto_{uuid.uuid4().hex[:8]}",
            "escalate_to_human",
            json.dumps(
                {
                    "reason": f"Safety backstop: {', '.join(safety.rules)}. Patient said: {user_text[:200]}",
                    "urgency": "urgent",
                }
            ),
        )
        conv.messages.append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {"name": call.name, "arguments": call.arguments},
                    }
                ],
            }
        )
        async for ev in run_tool(call, auto=True):
            yield ev
        # Escalation always happens; only add what Pearl hasn't already told them.
        said = final_text.lower()
        note = "" if re.search(r"\bstaff\b|\bcall you\b", said) else " A staff member will call you within 15 minutes."
        if safety.breathing_or_swallowing and "emergency" not in said:
            note += " If breathing or swallowing is getting harder, please go to the nearest hospital emergency department now."
        if note:
            final_text = (final_text + note).strip()
            spoken.append(note.strip())
            conv.messages.append({"role": "assistant", "content": final_text})
            yield {"type": "token", "text": note}

    total_ms = int((time.perf_counter() - t_turn) * 1000)
    timings["total_ms"] = total_ms
    timings["llm_ms"] = sum(c["ms"] for c in timings["llm_calls"])
    turn_text = " ".join(spoken)
    if turn_text:
        await convlog.log_message(conv.id, "assistant", turn_text, latency_ms=total_ms)
    if conv.ctx.outcome != outcome_before or conv.ctx.patient_id:
        await convlog.update_conversation(conv.id, outcome=conv.ctx.outcome, patient_id=conv.ctx.patient_id)
    yield {"type": "done", "text": turn_text, "outcome": conv.ctx.outcome, "tools_called": called, "timings": timings}
