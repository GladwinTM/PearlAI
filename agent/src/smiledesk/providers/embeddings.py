"""Embedding providers: ollama | openai_compatible | fastembed (in-process CPU, for deployment).

All must output EMBED_DIM (768) dimensions to match `kb_documents.embedding vector(768)`.
After switching provider, re-run `make ingest`.
"""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

from openai import AsyncOpenAI

from smiledesk.config import Settings, get_settings


class EmbeddingDimensionError(RuntimeError):
    pass


class Embedder(Protocol):
    name: str
    model: str

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class OpenAICompatibleEmbedder:
    """Works for Ollama (/v1/embeddings) and any OpenAI-compatible embeddings API."""

    def __init__(self, name: str, base_url: str, api_key: str, model: str) -> None:
        self.name = name
        self.model = model
        self._client = AsyncOpenAI(base_url=base_url, api_key=api_key or "unused", max_retries=1, timeout=60)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        resp = await self._client.embeddings.create(model=self.model, input=texts)
        return [d.embedding for d in sorted(resp.data, key=lambda d: d.index)]


class FastEmbedEmbedder:
    """In-process CPU embeddings (no Ollama needed). Install with `uv sync --extra fastembed`."""

    def __init__(self, model: str) -> None:
        self.name = "fastembed"
        self.model = model
        self._model: Any = None

    def _load(self) -> Any:
        if self._model is None:
            try:
                from fastembed import TextEmbedding  # pyright: ignore[reportMissingImports]
            except ImportError as e:  # pragma: no cover - depends on optional extra
                raise RuntimeError("fastembed is not installed. Run: uv sync --extra fastembed") from e
            self._model = TextEmbedding(model_name=self.model)
        return self._model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        def _run() -> list[list[float]]:
            return [list(map(float, v)) for v in self._load().embed(texts)]

        return await asyncio.to_thread(_run)


_embedder: Embedder | None = None


def get_embedder(settings: Settings | None = None) -> Embedder:
    global _embedder
    if _embedder is not None and settings is None:
        return _embedder
    s = settings or get_settings()
    emb: Embedder
    if s.embed_provider in ("ollama", "openai_compatible"):
        emb = OpenAICompatibleEmbedder(
            s.embed_provider, s.embed_base_url, s.embed_api_key.get_secret_value(), s.embed_model
        )
    elif s.embed_provider == "fastembed":
        emb = FastEmbedEmbedder(s.embed_model)
    else:  # pragma: no cover - guarded by the Literal type
        raise ValueError(f"Unknown EMBED_PROVIDER: {s.embed_provider}")
    if settings is None:
        _embedder = emb
    return emb


async def embed_query(text: str, settings: Settings | None = None) -> list[float]:
    s = settings or get_settings()
    [vec] = await get_embedder(settings).embed([s.embed_query_prefix + text])
    return vec


async def embed_documents(texts: list[str], settings: Settings | None = None) -> list[list[float]]:
    s = settings or get_settings()
    return await get_embedder(settings).embed([s.embed_document_prefix + t for t in texts])


async def check_embedding_dim(settings: Settings | None = None) -> int:
    """Embed a probe string and verify the dimension equals EMBED_DIM. Fails loudly otherwise."""
    s = settings or get_settings()
    vec = await embed_query("dimension check", settings)
    if len(vec) != s.embed_dim:
        raise EmbeddingDimensionError(
            f"Embedding model '{s.embed_model}' ({s.embed_provider}) returns {len(vec)} dims, "
            f"but EMBED_DIM={s.embed_dim} and the kb_documents.embedding column is vector(768). "
            "Pick a 768-dim model, or add a migration that changes the column and re-run `make ingest`."
        )
    return len(vec)
