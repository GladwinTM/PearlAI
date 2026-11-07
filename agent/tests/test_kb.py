"""RAG retrieval against local Supabase + the configured embedding provider."""

from __future__ import annotations

from typing import Any

import pytest
from supabase import Client

from smiledesk.db import rows
from smiledesk.providers.embeddings import check_embedding_dim, embed_query

pytestmark = [pytest.mark.db, pytest.mark.ollama]


@pytest.fixture(scope="module")
async def embeddings_up() -> None:
    try:
        await check_embedding_dim()
    except Exception as e:
        pytest.skip(f"Embedding provider not available: {e}")


async def _top(db: Client, question: str) -> list[dict[str, Any]]:
    vec = await embed_query(question)
    return rows(db.rpc("match_kb", {"query_embedding": vec, "match_count": 4}).execute())


@pytest.mark.parametrize(
    ("question", "expected_title"),
    [
        ("do you take insurance", "Insurance"),
        ("Do you take insurance? I have a family health policy.", "Insurance"),
        ("where can I park my car", "Location and parking"),
        ("how much is a root canal", "Treatment prices"),
        ("are you open on sunday", "Opening hours"),
        ("can I pay with UPI", "Payment methods"),
    ],
)
async def test_match_kb_top_hit(embeddings_up: None, db: Client, question: str, expected_title: str) -> None:
    rows = await _top(db, question)
    assert rows, "match_kb returned nothing; run `make ingest`"
    assert rows[0]["title"] == expected_title, [r["title"] for r in rows]


async def test_all_documents_embedded(db: Client) -> None:
    rows = db.table("kb_documents").select("id").is_("embedding", "null").execute().data
    assert rows == [], "Some FAQ docs have no embedding; run `make ingest`"
