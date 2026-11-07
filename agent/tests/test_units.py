"""Pure unit tests: no DB, no models."""

from __future__ import annotations

import pytest

from smiledesk.config import Settings
from smiledesk.ratelimit import RateLimiter
from smiledesk.warmup import running_on


def _settings(**kw: object) -> Settings:
    return Settings(_env_file=None, **kw)  # pyright: ignore[reportCallIssue]


def test_rate_limiter_window() -> None:
    rl = RateLimiter(limit=2, window_s=60)
    assert rl.allow("a", now=0) and rl.allow("a", now=1)
    assert not rl.allow("a", now=2)
    assert rl.allow("b", now=2)  # per key
    assert rl.allow("a", now=61)  # window slides


def test_defaults_are_all_local() -> None:
    s = _settings()
    assert s.all_local
    assert running_on(s) == "qwen3:8b · Whisper · Kokoro (all local)"
    assert s.stt_model_ref == "mlx-community/whisper-small.en-mlx"


def test_hosted_providers_are_not_local() -> None:
    s = _settings(
        llm_base_url="https://api.groq.com/openai/v1",
        llm_model="some-model",
        stt_provider="groq",
        stt_model="whisper-large-v3-turbo",
    )
    assert not s.all_local
    assert not s.llm_is_ollama
    assert s.stt_model_ref == "whisper-large-v3-turbo"
    assert "(all local)" not in running_on(s)


def test_full_repo_id_passthrough() -> None:
    assert (
        _settings(stt_model="mlx-community/whisper-small.en-mlx").stt_model_ref == "mlx-community/whisper-small.en-mlx"
    )


def test_ice_servers_must_be_a_list() -> None:
    with pytest.raises(ValueError):
        _settings(ice_servers_json='{"urls": "stun:x"}')
    assert _settings(ice_servers_json='[{"urls": "stun:x"}]')


def test_llm_extra_body() -> None:
    from smiledesk.providers.llm import llm_extra_body

    assert llm_extra_body(_settings()) == {"reasoning_effort": "none", "keep_alive": "30m"}
    hosted = _settings(llm_base_url="https://api.groq.com/openai/v1", llm_disable_thinking=False)
    assert llm_extra_body(hosted) == {}


async def test_embedding_dim_mismatch_fails_clearly(monkeypatch: pytest.MonkeyPatch) -> None:
    from smiledesk.providers import embeddings as emb

    class Fake:
        name, model = "fake", "fake-384"

        async def embed(self, texts: list[str]) -> list[list[float]]:
            return [[0.0] * 384 for _ in texts]

    monkeypatch.setattr(emb, "get_embedder", lambda settings=None: Fake())
    with pytest.raises(emb.EmbeddingDimensionError, match="384 dims"):
        await emb.check_embedding_dim(_settings())


def test_reasoning_effort_is_configurable_per_model() -> None:
    from smiledesk.config import Settings
    from smiledesk.providers.llm import llm_extra_body

    assert llm_extra_body(Settings(_env_file=None))["reasoning_effort"] == "none"  # pyright: ignore[reportCallIssue]
    groq = Settings(_env_file=None, llm_base_url="https://api.groq.com/openai/v1", llm_reasoning_effort="low")  # pyright: ignore[reportCallIssue]
    body = llm_extra_body(groq)
    assert body == {"reasoning_effort": "low"}  # no Ollama-only keep_alive for hosted providers
