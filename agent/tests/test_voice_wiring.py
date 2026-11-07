"""Voice wiring that can be checked without audio: shared tool schemas, transport factory, transcript notes."""

from __future__ import annotations

import pytest

from smiledesk.agent.tools import TOOL_SCHEMAS
from smiledesk.config import Settings
from smiledesk.voice.events import VoiceSession, strip_notes
from smiledesk.voice.pipeline import create_transport, tools_schema


def test_voice_uses_the_same_tool_schemas_as_chat() -> None:
    schema = tools_schema()
    voice = {f.name: (f.properties, f.required) for f in schema.standard_tools}  # pyright: ignore[reportAttributeAccessIssue]
    chat = {
        t["function"]["name"]: (t["function"]["parameters"]["properties"], t["function"]["parameters"]["required"])
        for t in TOOL_SCHEMAS
    }
    assert voice == chat


def test_transport_factory() -> None:
    with pytest.raises(NotImplementedError, match="daily"):
        create_transport(object(), Settings(_env_file=None, voice_transport="daily"))  # pyright: ignore[reportCallIssue]


def test_strip_notes_removes_clinic_system_note() -> None:
    said = "My face is swollen\n\n[Clinic system note, not from the caller: red-flag symptoms (x). Staff alerted.]"
    assert strip_notes(said) == "My face is swollen"
    assert strip_notes(None) == ""


def test_write_recency_window() -> None:
    from smiledesk.agent.tools import ToolContext

    s = VoiceSession(conversation_id=None, ctx=ToolContext(), vad_stop_secs=0.5)
    assert not s.wrote_recently()
    s.turn_index, s.last_write_turn = 3, 3
    assert s.wrote_recently()
    s.turn_index = 4
    assert s.wrote_recently()  # recap in the next turn is fine
    s.turn_index = 5
    assert not s.wrote_recently()


def test_plain_history_keeps_only_portable_messages() -> None:
    from smiledesk.voice.pipeline import _plain_history  # pyright: ignore[reportPrivateUsage]

    msgs = [
        {"role": "system", "content": "prompt"},
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "lookup_patient", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "c1", "content": "{}"},
        "not-a-dict",
    ]
    out = _plain_history(msgs)
    assert [m["role"] for m in out] == ["user", "assistant", "tool"]
    out[0]["content"] = "changed"
    assert msgs[1]["content"] == "hi"  # a copy, not shared with the live context


def test_offer_rejects_a_malformed_conversation_id() -> None:
    from fastapi.testclient import TestClient

    from smiledesk.main import app

    with TestClient(app) as http:
        r = http.post(
            "/api/offer",
            json={"sdp": "v=0", "type": "offer", "requestData": {"persona": "ravi", "conversation_id": "nope"}},
        )
    assert r.status_code == 400
    assert "conversation_id" in r.json()["detail"]


def test_daily_voice_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from smiledesk.api import voice
    from smiledesk.config import get_settings
    from smiledesk.main import app

    monkeypatch.setattr(get_settings(), "max_voice_calls_per_day", 2)
    monkeypatch.setattr(voice, "_calls_by_day", {voice.now().date().isoformat(): 2})
    with TestClient(app) as http:
        cfg = http.get("/api/voice/config").json()
        assert cfg["daily_limit_reached"] is True and "resting" in cfg["resting_message"]
        r = http.post("/api/offer", json={"sdp": "v=0", "type": "offer", "requestData": {"persona": "ravi"}})
    assert r.status_code == 429 and "resting" in r.json()["detail"]

    monkeypatch.setattr(get_settings(), "max_voice_calls_per_day", 0)  # 0 = unlimited
    assert voice.daily_limit_reached() is False
