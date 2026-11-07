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


def test_client_ip_ignores_spoofable_forwarded_entries() -> None:
    from starlette.requests import Request

    from smiledesk.ratelimit import client_ip

    def req(headers: dict[str, str]) -> Request:
        raw = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
        return Request({"type": "http", "headers": raw, "client": ("10.0.0.9", 1234)})

    assert client_ip(req({"Fly-Client-IP": "203.0.113.7", "X-Forwarded-For": "1.1.1.1"})) == "203.0.113.7"
    # The client can prepend anything; only the entry our proxy appended counts.
    assert client_ip(req({"X-Forwarded-For": "6.6.6.6, 203.0.113.7"})) == "203.0.113.7"
    assert client_ip(req({})) == "10.0.0.9"


def test_parse_fallbacks() -> None:
    from smiledesk.providers.llm import parse_fallbacks

    assert parse_fallbacks(" openai/gpt-oss-120b , qwen/qwen3.8-27b:none,") == [
        ("openai/gpt-oss-120b", None),
        ("qwen/qwen3.8-27b", "none"),
    ]
    assert parse_fallbacks("qwen3:8b") == [("qwen3:8b", None)]  # an Ollama tag, not a reasoning setting
    assert parse_fallbacks("") == []


async def test_rate_limited_model_falls_back_with_its_own_reasoning_setting() -> None:
    import json

    import httpx2
    from openai import AsyncOpenAI

    from smiledesk.providers.llm import ModelFallbackTransport

    seen: list[dict[str, object]] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        seen.append({"model": body["model"], "reasoning_effort": body.get("reasoning_effort")})
        if body["model"] in ("a", "b"):
            return httpx2.Response(429, json={"error": {"message": "rate limited"}})
        return httpx2.Response(200, json={"id": "x", "object": "chat.completion", "created": 0, "model": body["model"],
                                         "choices": [{"index": 0, "finish_reason": "stop",
                                                      "message": {"role": "assistant", "content": "hi"}}]})  # fmt: skip

    transport = ModelFallbackTransport([("b", None), ("c", "none")], inner=httpx2.MockTransport(handler))
    client = AsyncOpenAI(
        base_url="http://llm.test/v1", api_key="k", max_retries=0, http_client=httpx2.AsyncClient(transport=transport)
    )
    out = await client.chat.completions.create(
        model="a", messages=[{"role": "user", "content": "hi"}], extra_body={"reasoning_effort": "low"}
    )
    assert out.choices[0].message.content == "hi" and out.model == "c"
    # b inherits the primary's setting; c uses its own ("none").
    assert seen == [
        {"model": "a", "reasoning_effort": "low"},
        {"model": "b", "reasoning_effort": "low"},
        {"model": "c", "reasoning_effort": "none"},
    ]


async def test_fallback_gives_up_with_the_last_429() -> None:
    import httpx2
    from openai import AsyncOpenAI, RateLimitError

    from smiledesk.providers.llm import ModelFallbackTransport

    transport = ModelFallbackTransport(
        [("b", None)], inner=httpx2.MockTransport(lambda r: httpx2.Response(429, json={}))
    )
    client = AsyncOpenAI(
        base_url="http://llm.test/v1", api_key="k", max_retries=0, http_client=httpx2.AsyncClient(transport=transport)
    )
    try:
        await client.chat.completions.create(model="a", messages=[{"role": "user", "content": "hi"}])
    except RateLimitError:
        return
    raise AssertionError("expected RateLimitError")
