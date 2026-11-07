"""One OpenAI-compatible client for every LLM (Ollama, Groq, OpenRouter, OpenAI, Gemini's compat API...).

Switching provider is an .env change: LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
"""

from __future__ import annotations

from typing import Any

from openai import AsyncOpenAI

from smiledesk.config import Settings, get_settings

_clients: dict[tuple[str, str], AsyncOpenAI] = {}


def _client(base_url: str, api_key: str) -> AsyncOpenAI:
    key = (base_url, api_key)
    if key not in _clients:
        _clients[key] = AsyncOpenAI(base_url=base_url, api_key=api_key or "unused", max_retries=1, timeout=120)
    return _clients[key]


def get_llm_client(settings: Settings | None = None) -> AsyncOpenAI:
    s = settings or get_settings()
    return _client(s.llm_base_url, s.llm_api_key.get_secret_value())


def get_judge_client(settings: Settings | None = None) -> AsyncOpenAI:
    s = settings or get_settings()
    return _client(s.judge_base_url, s.judge_api_key.get_secret_value())


def llm_extra_body(settings: Settings | None = None) -> dict[str, Any]:
    """Provider-specific request fields, kept in one place.

    - `reasoning_effort: "none"` turns off Qwen3 thinking on Ollama's OpenAI endpoint
      (measured: ~35 s → ~0.5 s for a short reply on an M-series Mac).
    - `keep_alive` keeps the model resident in Ollama between turns.
    """
    s = settings or get_settings()
    body: dict[str, Any] = {}
    if s.llm_disable_thinking:
        body["reasoning_effort"] = "none"
    if s.llm_is_ollama:
        body["keep_alive"] = s.llm_keep_alive
    return body


async def check_llm(settings: Settings | None = None) -> dict[str, Any]:
    """Cheap health check: the endpoint answers and the configured model exists."""
    s = settings or get_settings()
    models = await get_llm_client(s).models.list()
    ids = {m.id for m in models.data}
    if s.llm_model not in ids:
        hint = f"ollama pull {s.llm_model}" if s.llm_is_ollama else "check LLM_MODEL"
        raise RuntimeError(f"Model '{s.llm_model}' not found at {s.llm_base_url}. Fix: {hint}")
    return {"model": s.llm_model}


async def warmup_llm(settings: Settings | None = None) -> None:
    """Load the model into memory (and keep it there) so the first real turn is fast."""
    s = settings or get_settings()
    await get_llm_client(s).chat.completions.create(
        model=s.llm_model,
        messages=[{"role": "user", "content": "Reply with the single word: ready"}],
        max_tokens=5,
        temperature=0,
        extra_body=llm_extra_body(s),
    )
