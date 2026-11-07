"""POST /api/chat over SSE, parsed the way the browser parses it (data payloads only)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from supabase import Client

from smiledesk.agent import core
from smiledesk.agent.core import Completed, TextDelta
from smiledesk.config import get_settings

pytestmark = pytest.mark.db


class EchoLLM:
    """Replies with how many user messages it can see, so we can tell whether history carried over."""

    model = "echo"

    async def stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], tool_choice: str
    ) -> AsyncIterator[TextDelta | Completed]:
        n = sum(1 for m in messages if m["role"] == "user")
        yield TextDelta(f"I can see {n} user messages.")
        yield Completed([])


def parse_sse(body: str) -> list[dict[str, Any]]:
    """Only `data:` lines, exactly like web/lib/chat.ts used to: the payload must be self-describing."""
    out = []
    for frame in body.strip().split("\n\n"):
        data = "\n".join(line[6:] for line in frame.split("\n") if line.startswith("data: "))
        if data:
            out.append(json.loads(data))
    return out


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, clean_db: Client) -> TestClient:
    monkeypatch.setattr(core, "OpenAIChatLLM", EchoLLM)
    get_settings().warmup_on_startup = False  # no model loading in tests
    from smiledesk.main import create_app

    return TestClient(create_app())


def test_every_event_carries_type_and_conversation_continues(client: TestClient) -> None:
    r1 = client.post("/api/chat", json={"message": "hey", "persona": "ravi"})
    assert r1.status_code == 200 and r1.headers["content-type"].startswith("text/event-stream")
    ev1 = parse_sse(r1.text)
    assert all("type" in e for e in ev1), ev1
    assert ev1[0]["type"] == "conversation"
    cid = ev1[0]["conversation_id"]
    assert [e["name"] for e in ev1 if e["type"] == "tool_call"] == ["lookup_patient"]  # caller ID, first turn only
    assert ev1[-1]["type"] == "done" and ev1[-1]["text"] == "I can see 1 user messages."

    r2 = client.post("/api/chat", json={"message": "checkup", "persona": "ravi", "conversation_id": cid})
    ev2 = parse_sse(r2.text)
    assert ev2[0]["conversation_id"] == cid
    assert not [e for e in ev2 if e["type"] == "tool_call"]  # no repeated caller-ID lookup
    assert ev2[-1]["text"] == "I can see 2 user messages."


def test_validation(client: TestClient) -> None:
    assert client.post("/api/chat", json={"message": ""}).status_code == 422
    assert client.post("/api/chat", json={"message": "hi", "persona": "hacker"}).status_code == 400
