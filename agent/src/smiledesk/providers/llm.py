"""One OpenAI-compatible client for every LLM (Ollama, Groq, OpenRouter, OpenAI, Gemini's compat API...).

Switching provider is an .env change: LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import httpx2  # the OpenAI SDK's HTTP layer (a separate package from httpx)
from loguru import logger
from openai import AsyncOpenAI

from smiledesk.config import Settings, get_settings

_clients: dict[tuple[str, str, str], AsyncOpenAI] = {}


def parse_fallbacks(spec: str) -> list[tuple[str, str | None]]:
    """ "a,b:none" → [("a", None), ("b", "none")]. A model id may itself contain a colon (Ollama tags), so only a
    known reasoning_effort value after the last colon is treated as one."""
    out: list[tuple[str, str | None]] = []
    for raw in spec.split(","):
        item = raw.strip()
        if not item:
            continue
        model, _, effort = item.rpartition(":")
        if model and effort in ("none", "low", "medium", "high", "default"):
            out.append((model, effort))
        else:
            out.append((item, None))
    return out


class ModelFallbackTransport(httpx2.AsyncBaseTransport):
    """Retries a rate-limited chat completion (HTTP 429) on the next model, before the client ever sees the 429.

    Sits under the OpenAI SDK, so chat (core.py) and voice (Pipecat) get it for free and streaming is untouched:
    the status code arrives before any body is read.
    """

    def __init__(self, fallbacks: list[tuple[str, str | None]], inner: httpx2.AsyncBaseTransport | None = None) -> None:
        self.fallbacks = fallbacks
        self.inner = inner or httpx2.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        if request.method != "POST" or not request.url.path.endswith("/chat/completions") or not self.fallbacks:
            return await self.inner.handle_async_request(request)
        body = json.loads(await request.aread())
        primary = body.get("model")
        attempts: list[tuple[str, str | None]] = [(primary, body.get("reasoning_effort"))]
        attempts += [(m, e) for m, e in self.fallbacks if m != primary]
        response: httpx2.Response | None = None
        for i, (model, effort) in enumerate(attempts):
            b = {**body, "model": model}
            if i > 0:
                b.pop("reasoning_effort", None)
                if effort is not None:
                    b["reasoning_effort"] = effort
                elif "reasoning_effort" in body:
                    b["reasoning_effort"] = body["reasoning_effort"]
            content = json.dumps(b).encode()
            headers = [(k, v) for k, v in request.headers.raw if k.lower() != b"content-length"]
            headers.append((b"content-length", str(len(content)).encode()))
            attempt = httpx2.Request(
                request.method, request.url, headers=headers, content=content, extensions=request.extensions
            )
            response = await self.inner.handle_async_request(attempt)
            if response.status_code != 429 or i == len(attempts) - 1:
                if i > 0:
                    logger.info(f"LLM fallback: answered by {model} (after {i} rate-limited model(s))")
                return response
            await response.aclose()
            logger.info(f"LLM {model} is rate-limited; trying {attempts[i + 1][0]}")
        assert response is not None
        return response

    async def aclose(self) -> None:
        await self.inner.aclose()


def _client(base_url: str, api_key: str, fallbacks: str = "") -> AsyncOpenAI:
    key = (base_url, api_key, fallbacks)
    if key not in _clients:
        http = (
            httpx2.AsyncClient(transport=ModelFallbackTransport(parse_fallbacks(fallbacks)), timeout=120)
            if fallbacks
            else None
        )
        _clients[key] = AsyncOpenAI(
            base_url=base_url, api_key=api_key or "unused", max_retries=1, timeout=120, http_client=http
        )
    return _clients[key]


def get_llm_client(settings: Settings | None = None) -> AsyncOpenAI:
    s = settings or get_settings()
    return _client(s.llm_base_url, s.llm_api_key.get_secret_value(), s.llm_fallback_models)


def get_judge_client(settings: Settings | None = None) -> AsyncOpenAI:
    s = settings or get_settings()
    return _client(s.judge_base_url, s.judge_api_key.get_secret_value())


def llm_extra_body(settings: Settings | None = None) -> dict[str, Any]:
    """Provider-specific request fields, kept in one place.

    - `reasoning_effort` (LLM_REASONING_EFFORT, default "none") turns off Qwen3 thinking on Ollama's OpenAI endpoint
      (measured: ~35 s → ~0.5 s for a short reply on an M-series Mac). Models that always reason take their lowest
      allowed value instead, e.g. "low" for Groq's gpt-oss.
    - `keep_alive` keeps the model resident in Ollama between turns.
    """
    s = settings or get_settings()
    body: dict[str, Any] = {}
    if s.llm_disable_thinking:
        body["reasoning_effort"] = s.llm_reasoning_effort
    if s.llm_is_ollama:
        body["keep_alive"] = s.llm_keep_alive
    return body


async def ensure_ollama_context_model(settings: Settings | None = None) -> str | None:
    """Create the derived Ollama model with LLM_NUM_CTX if it doesn't exist yet (shares weights; instant)."""
    s = settings or get_settings()
    target = s.llm_request_model
    if target == s.llm_model:
        return None
    root = s.llm_base_url.rstrip("/").removesuffix("/v1")
    async with httpx.AsyncClient(timeout=120) as http:
        tags = (await http.get(f"{root}/api/tags")).json().get("models", [])
        if any(m.get("name") == target for m in tags):
            return target
        r = await http.post(
            f"{root}/api/create",
            json={"model": target, "from": s.llm_model, "parameters": {"num_ctx": s.llm_num_ctx}, "stream": False},
        )
        if r.status_code != 200:
            raise RuntimeError(f"Could not create {target} from {s.llm_model}: {r.text[:200]}")
    return target


async def check_llm(settings: Settings | None = None) -> dict[str, Any]:
    """Cheap health check: the endpoint answers and the configured model exists."""
    s = settings or get_settings()
    models = await get_llm_client(s).models.list()
    ids = {m.id for m in models.data}
    if s.llm_model not in ids:
        hint = f"ollama pull {s.llm_model}" if s.llm_is_ollama else "check LLM_MODEL"
        raise RuntimeError(f"Model '{s.llm_model}' not found at {s.llm_base_url}. Fix: {hint}")
    await ensure_ollama_context_model(s)
    return {"model": s.llm_model, "request_model": s.llm_request_model}


async def warmup_llm(settings: Settings | None = None) -> None:
    """Load the model into memory (and keep it there) so the first real turn is fast."""
    s = settings or get_settings()
    await get_llm_client(s).chat.completions.create(
        model=s.llm_request_model,
        messages=[{"role": "user", "content": "Reply with the single word: ready"}],
        max_tokens=5,
        temperature=0,
        extra_body=llm_extra_body(s),
    )
