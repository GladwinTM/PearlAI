"""The tool-calling loop with a scripted fake LLM: deterministic tests of the loop's own logic."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from supabase import Client

from smiledesk.agent.core import MAX_TOOL_ROUNDS, Completed, Conversation, TextDelta, ToolCall, _ThinkFilter, run_turn
from smiledesk.agent.tools import ToolContext
from smiledesk.db import rows
from tests.conftest import next_weekday

pytestmark = pytest.mark.db

Step = tuple[str, list[tuple[str, dict[str, Any]]]]  # (text, [(tool, args)])


class ScriptedLLM:
    model = "scripted"

    def __init__(self, steps: list[Step]) -> None:
        self.steps = list(steps)
        self.calls: list[dict[str, Any]] = []

    async def stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], tool_choice: str
    ) -> AsyncIterator[TextDelta | Completed]:
        self.calls.append({"messages": [dict(m) for m in messages], "tool_choice": tool_choice})
        text, calls = self.steps.pop(0) if self.steps else ("Okay.", [])
        for word in text.split(" ") if text else []:
            yield TextDelta(word + " ")
        yield Completed(
            [ToolCall(f"c{len(self.calls)}_{i}", name, json.dumps(args)) for i, (name, args) in enumerate(calls)]
        )


def new_conv(persona: str | None = None) -> Conversation:
    return Conversation(id=None, persona=persona, ctx=ToolContext())


async def collect(conv: Conversation, text: str, llm: ScriptedLLM) -> list[dict[str, Any]]:
    return [ev async for ev in run_turn(conv, text, llm)]


def types(events: list[dict[str, Any]]) -> list[str]:
    return [e["type"] for e in events]


async def test_tool_round_then_answer(clean_db: Client) -> None:
    llm = ScriptedLLM([("", [("lookup_patient", {"phone": "9800000001"})]), ("Hi Ravi, how can I help?", [])])
    conv = new_conv()
    ev = await collect(conv, "Hi, it's Ravi, 98000 00001", llm)
    assert types(ev) == ["tool_call", "tool_result", "token", "token", "token", "token", "token", "token", "done"]
    done = ev[-1]
    assert done["text"] == "Hi Ravi, how can I help?"
    assert done["tools_called"] == ["lookup_patient"]
    assert done["timings"]["rounds"] == 2
    # history: user, assistant(tool_calls, empty content), tool, assistant(text)
    roles = [m["role"] for m in conv.messages]
    assert roles == ["user", "assistant", "tool", "assistant"]
    assert conv.messages[1]["content"] == "" and conv.messages[1]["tool_calls"]


async def test_caller_id_auto_lookup(clean_db: Client) -> None:
    llm = ScriptedLLM([("Hi Ravi!", [])])
    conv = new_conv("ravi")
    ev = await collect(conv, "Hello", llm)
    first = ev[0]
    assert first["type"] == "tool_call" and first["name"] == "lookup_patient" and first.get("auto")
    assert ev[1]["result"]["found"]
    ev2 = await collect(conv, "Thanks", ScriptedLLM([("Bye", [])]))
    assert "tool_call" not in types(ev2)  # only once per conversation


async def test_announced_action_is_nudged(clean_db: Client) -> None:
    llm = ScriptedLLM(
        [
            ("Let me check that for you, one moment.", []),
            ("", [("check_availability", {"date": next_weekday(3).isoformat(), "appointment_type": "checkup"})]),
            ("I found some times.", []),
        ]
    )
    ev = await collect(new_conv(), "Any checkup on Wednesday?", llm)
    assert "check_availability" in ev[-1]["tools_called"]
    assert ev[-1]["timings"]["nudged"] == "announced_action"
    assert "you said you would check" in llm.calls[1]["messages"][-1]["content"]


async def test_ungrounded_times_are_retracted_and_rechecked(clean_db: Client) -> None:
    wed = next_weekday(3).isoformat()
    llm = ScriptedLLM(
        [
            ("I have ten fifteen AM or 4 PM.", []),
            ("", [("check_availability", {"date": wed, "appointment_type": "checkup"})]),
            ("Sorry, let me give real times.", []),
        ]
    )
    ev = await collect(new_conv(), "Checkup Wednesday?", llm)
    retract = next(e for e in ev if e["type"] == "retract")
    assert retract["times"] == ["10:15", "16:00"]
    assert "ten fifteen" not in ev[-1]["text"]  # not in the logged transcript
    assert ev[-1]["timings"]["nudged"] == "ungrounded_times"


async def test_times_the_user_said_are_not_flagged(clean_db: Client) -> None:
    llm = ScriptedLLM([("7 PM isn't possible for new patients, sorry.", [])])
    ev = await collect(new_conv(), "Can I come at 7 PM?", llm)
    assert "retract" not in types(ev)


async def test_safety_backstop_escalates_when_model_does_not(clean_db: Client) -> None:
    llm = ScriptedLLM([("That sounds uncomfortable. It may be serious.", [])])
    ev = await collect(new_conv(), "My face is swollen and I have a fever", llm)
    assert ev[0]["type"] == "safety" and ev[0]["rules"] == ["swelling_with_fever"]
    auto = next(e for e in ev if e["type"] == "tool_call")
    assert auto["name"] == "escalate_to_human" and auto.get("auto") and auto["args"]["urgency"] == "urgent"
    assert "15 minutes" in ev[-1]["text"]
    assert ev[-1]["outcome"] == "escalated"
    # The instruction reached the model, attached to the user turn (qwen3's template drops mid-chat system messages).
    user_msg = llm.calls[0]["messages"][-1]
    assert user_msg["role"] == "user" and "URGENT" in user_msg["content"]
    rows(clean_db.table("escalations").delete().like("reason", "Safety backstop%").execute())


async def test_safety_no_double_escalation(clean_db: Client) -> None:
    llm = ScriptedLLM(
        [("", [("escalate_to_human", {"reason": "swelling", "urgency": "urgent"})]), ("Staff will call you.", [])]
    )
    ev = await collect(new_conv(), "My face is swollen and I have a fever", llm)
    assert [e["name"] for e in ev if e["type"] == "tool_call"] == ["escalate_to_human"]
    clean_db.table("escalations").delete().eq("reason", "swelling").execute()


async def test_max_rounds_forces_an_answer(clean_db: Client) -> None:
    loop = [("", [("get_clinic_info", {"question": "x"})])] * (MAX_TOOL_ROUNDS + 2)
    llm = ScriptedLLM(loop)
    ev = await collect(new_conv(), "loop forever", llm)
    assert len([e for e in ev if e["type"] == "tool_call"]) == MAX_TOOL_ROUNDS
    assert llm.calls[-1]["tool_choice"] == "none"
    assert ev[-1]["type"] == "done" and ev[-1]["text"]


async def test_bad_json_arguments_are_reported_to_model(clean_db: Client) -> None:
    class BadArgs(ScriptedLLM):
        async def stream(self, messages, tools, tool_choice):
            self.calls.append({"messages": messages, "tool_choice": tool_choice})
            if len(self.calls) == 1:
                yield Completed([ToolCall("x1", "lookup_patient", "{phone: oops")])
            else:
                yield TextDelta("What's your number?")
                yield Completed([])

    conv = new_conv()
    ev = await collect(conv, "hi", BadArgs([]))
    result = next(e for e in ev if e["type"] == "tool_result")["result"]
    assert "invalid JSON" in result["error"]


def test_think_filter() -> None:
    f = _ThinkFilter()
    out = f.feed("<thi") + f.feed("nk>secret</th") + f.feed("ink>Hello <b>there</b>") + f.flush()
    assert out == "Hello <b>there</b>"
