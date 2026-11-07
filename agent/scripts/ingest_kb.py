"""Embed every kb_documents row and store the vector.

Usage (from agent/):  uv run python scripts/ingest_kb.py [--only-missing]
Re-run after changing EMBED_PROVIDER / EMBED_MODEL.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from datetime import UTC, datetime
from typing import Any

from smiledesk.config import get_settings
from smiledesk.db import get_db, rows
from smiledesk.providers.embeddings import check_embedding_dim, embed_documents


def _doc_text(row: dict[str, Any]) -> str:
    # Title + content gives the retriever both the topic word ("Insurance") and the detail.
    return f"{row['title']}\n{row['content']}"


async def main(only_missing: bool) -> int:
    s = get_settings()
    dim = await check_embedding_dim(s)
    print(f"Embedding with {s.embed_provider}:{s.embed_model} ({dim} dims)")

    q = get_db().table("kb_documents").select("id, title, content").order("id")
    if only_missing:
        q = q.is_("embedding", "null")
    docs = rows(q.execute())
    if not docs:
        print("Nothing to embed.")
        return 0

    t0 = time.perf_counter()
    vectors = await embed_documents([_doc_text(r) for r in docs], s)
    for row, vec in zip(docs, vectors, strict=True):
        get_db().table("kb_documents").update({"embedding": vec, "updated_at": datetime.now(UTC).isoformat()}).eq(
            "id", row["id"]
        ).execute()
        print(f"  ✓ {row['id']:>3}  {row['title']}")
    print(f"Embedded {len(docs)} documents in {time.perf_counter() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--only-missing", action="store_true")
    sys.exit(asyncio.run(main(ap.parse_args().only_missing)))
