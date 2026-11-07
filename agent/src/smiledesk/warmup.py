"""Startup warmup + live component status, surfaced by GET /api/health and the UI boot screen.

Honest by design: every row reflects a real check (DB query, model load, embedding probe),
never a timer.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from loguru import logger
from postgrest.types import CountMethod

from smiledesk.config import Settings, get_settings
from smiledesk.db import get_db
from smiledesk.providers.embeddings import check_embedding_dim
from smiledesk.providers.llm import check_llm, warmup_llm
from smiledesk.providers.stt import get_stt
from smiledesk.providers.tts import get_tts

Status = Literal["pending", "loading", "ready", "error"]
COMPONENTS = ("database", "llm", "stt", "tts", "embeddings", "knowledge_base")


@dataclass
class Component:
    key: str
    label: str
    provider: str = ""
    model: str = ""
    status: Status = "pending"
    detail: str = ""
    error: str | None = None
    fix: str | None = None
    duration_ms: int | None = None
    local: bool = True
    extra: dict[str, Any] = field(default_factory=dict)


class WarmupState:
    def __init__(self, s: Settings) -> None:
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.components: dict[str, Component] = {
            "database": Component(
                "database",
                "Database",
                "supabase",
                "postgres",
                local="127.0.0.1" in s.supabase_url or "localhost" in s.supabase_url,
            ),
            "llm": Component(
                "llm",
                "Language model",
                "ollama" if s.llm_is_ollama else "openai_compatible",
                s.llm_model,
                local=s.llm_is_ollama,
            ),
            "stt": Component(
                "stt", "Speech recognition", s.stt_provider, s.stt_model, local=s.stt_provider == "local_whisper"
            ),
            "tts": Component("tts", "Voice", s.tts_provider, f"{s.tts_model} ({s.tts_voice})", local=True),
            "embeddings": Component(
                "embeddings",
                "Embeddings",
                s.embed_provider,
                s.embed_model,
                local=s.embed_provider != "openai_compatible",
            ),
            "knowledge_base": Component("knowledge_base", "Knowledge base", "pgvector", f"{s.embed_dim}-dim"),
        }

    def to_dict(self) -> dict[str, Any]:
        return {k: asdict(c) for k, c in self.components.items()}


_state: WarmupState | None = None


def get_state() -> WarmupState:
    global _state
    if _state is None:
        _state = WarmupState(get_settings())
    return _state


def _fix_hint(key: str, err: str, s: Settings) -> str:
    e = err.lower()
    if key == "database":
        if "non-local" in e:
            return "Set SUPABASE_SERVICE_ROLE_KEY in the server environment."
        return "Supabase isn't reachable. Start it with `make db-start` (Docker must be running)."
    if key == "llm":
        if "not found" in e:
            return f"Pull the model: `ollama pull {s.llm_model}`." if s.llm_is_ollama else "Check LLM_MODEL in .env."
        return (
            "Ollama isn't running. Start it with `ollama serve`."
            if s.llm_is_ollama
            else "Check LLM_BASE_URL / LLM_API_KEY."
        )
    if key == "embeddings":
        if "dims" in e:
            return "Use a 768-dim embedding model (EMBED_DIM) or add a migration, then `make ingest`."
        if s.embed_provider == "ollama":
            return f"Start Ollama (`ollama serve`) and pull the model: `ollama pull {s.embed_model}`."
        return "Check EMBED_* settings in .env."
    if key == "knowledge_base":
        return "Embed the FAQ: `make ingest`."
    if key == "stt":
        return (
            "Check STT_MODEL; the first run downloads Whisper weights from Hugging Face."
            if s.stt_provider == "local_whisper"
            else "Set STT_API_KEY."
        )
    if key == "tts":
        return "Check TTS_VOICE; the first run downloads Kokoro model files."
    return ""


async def _run(key: str, fn: Any, s: Settings) -> bool:
    c = get_state().components[key]
    c.status, c.error, c.fix = "loading", None, None
    t0 = time.perf_counter()
    try:
        detail = await fn()
        c.status = "ready"
        c.detail = detail or ""
        return True
    except Exception as exc:
        c.status = "error"
        c.error = str(exc) or exc.__class__.__name__
        c.fix = _fix_hint(key, c.error, s)
        logger.error(f"[warmup] {key} failed: {c.error} | fix: {c.fix}")
        return False
    finally:
        c.duration_ms = int((time.perf_counter() - t0) * 1000)


async def check_database() -> str:
    def _q() -> int:
        res = get_db().table("dentists").select("id", count=CountMethod.exact).limit(1).execute()
        return res.count or 0

    n = await asyncio.to_thread(_q)
    if n == 0:
        raise RuntimeError("Connected, but no dentists found: the seed hasn't run. Run `make db-reset`.")
    return f"{n} dentists"


async def check_knowledge_base() -> str:
    def _q() -> tuple[int, int]:
        db = get_db()
        total = db.table("kb_documents").select("id", count=CountMethod.exact).limit(1).execute().count or 0
        has_embedding = db.table("kb_documents").select("id", count=CountMethod.exact).not_.is_("embedding", "null")
        embedded = has_embedding.limit(1).execute().count or 0
        return total, embedded

    total, embedded = await asyncio.to_thread(_q)
    if total == 0:
        raise RuntimeError("No FAQ documents found. Run `make db-reset`.")
    if embedded < total:
        raise RuntimeError(f"Only {embedded}/{total} FAQ documents are embedded.")
    return f"{embedded}/{total} documents embedded"


async def run_warmup() -> None:
    """Runs once at startup (in the background). Order = what the boot screen shows."""
    s = get_settings()
    st = get_state()
    st.started_at = time.time()
    logger.info("[warmup] starting")

    db_ok = await _run("database", check_database, s)
    if db_ok:
        try:
            from smiledesk.agent.prompts import sync_prompt_versions

            await asyncio.to_thread(sync_prompt_versions)
        except Exception as e:
            logger.error(f"[warmup] prompt sync failed: {e}")

    async def _embeddings() -> str:
        dim = await check_embedding_dim(s)
        return f"{dim} dims"

    emb_ok = await _run("embeddings", _embeddings, s)
    if emb_ok and st.components["database"].status == "ready":
        await _run("knowledge_base", check_knowledge_base, s)
    else:
        kb = st.components["knowledge_base"]
        kb.status, kb.error = "error", "Waiting on database and embeddings."
        kb.fix = "Fix the rows above first."

    async def _llm() -> str:
        info = await check_llm(s)
        t0 = time.perf_counter()
        await warmup_llm(s)
        if st.components["database"].status == "ready":
            from smiledesk.agent.core import prefill_prompt_cache

            await prefill_prompt_cache(s)
        ctx = f", context {s.llm_num_ctx}" if info["request_model"] != s.llm_model else ""
        return f"loaded{ctx}, first reply in {int((time.perf_counter() - t0) * 1000)} ms"

    async def _stt() -> str:
        stt = get_stt()
        await asyncio.to_thread(stt.warmup)
        return stt.model

    async def _tts() -> str:
        tts = get_tts()
        await asyncio.to_thread(tts.warmup)
        return f"voice {tts.voice}"

    # LLM loads on the Ollama process; Whisper and Kokoro load in this process. Run them together.
    await asyncio.gather(_run("llm", _llm, s), _run("stt", _stt, s), _run("tts", _tts, s))

    st.finished_at = time.time()
    failed = [k for k, c in st.components.items() if c.status == "error"]
    logger.info(f"[warmup] finished in {st.finished_at - st.started_at:.1f}s; failed={failed or 'none'}")


def running_on(s: Settings) -> str:
    stt = "Whisper" if s.stt_provider == "local_whisper" else f"{s.stt_provider} {s.stt_model}"
    tts = "Kokoro" if s.tts_provider == "kokoro" else s.tts_provider
    suffix = " (all local)" if s.all_local else ""
    return f"{s.llm_model} · {stt} · {tts}{suffix}"
