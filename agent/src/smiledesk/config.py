"""All runtime settings, read from the repo-root .env (or the process environment).

This is the ONLY Python module allowed to contain model names / provider URLs as defaults
(see BUILD_PLAN.md §12 rule 4). Everything else reads them from `get_settings()`.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

AGENT_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = AGENT_DIR.parent

# Short names accepted in STT_MODEL for the local MLX Whisper provider → Hugging Face repos.
# A full repo id (containing "/") is passed through unchanged.
MLX_WHISPER_MODELS: dict[str, str] = {
    "tiny": "mlx-community/whisper-tiny",
    "small.en": "mlx-community/whisper-small.en-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3-turbo-q4": "mlx-community/whisper-large-v3-turbo-q4",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", AGENT_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Clinic
    clinic_timezone: str = "Asia/Kolkata"

    # ── Supabase
    supabase_url: str = "http://127.0.0.1:54321"
    supabase_service_role_key: SecretStr = SecretStr("")

    # ── LLM (any OpenAI-compatible API)
    llm_base_url: str = "http://localhost:11434/v1"
    llm_api_key: SecretStr = SecretStr("ollama")
    llm_model: str = "qwen3:8b"
    llm_temperature: float = 0.3
    llm_disable_thinking: bool = True
    llm_keep_alive: str = "30m"  # Ollama only; ignored by hosted providers

    judge_base_url: str = "http://localhost:11434/v1"
    judge_api_key: SecretStr = SecretStr("ollama")
    judge_model: str = "qwen3:8b"

    # ── Speech-to-text
    stt_provider: Literal["local_whisper", "groq"] = "local_whisper"
    stt_model: str = "large-v3-turbo"
    stt_api_key: SecretStr = SecretStr("")
    stt_base_url: str = "https://api.groq.com/openai/v1"  # used by the groq provider

    # ── Text-to-speech
    tts_provider: Literal["kokoro"] = "kokoro"
    tts_voice: str = "af_heart"
    tts_model: str = "kokoro-82m"  # display label; kokoro-onnx v1.0 weights

    # ── Embeddings
    embed_provider: Literal["ollama", "openai_compatible", "fastembed"] = "ollama"
    embed_base_url: str = "http://localhost:11434/v1"
    embed_api_key: SecretStr = SecretStr("ollama")
    embed_model: str = "nomic-embed-text"
    embed_dim: int = 768
    # nomic-embed models are trained with task prefixes; set both to "" for models that aren't.
    embed_query_prefix: str = "search_query: "
    embed_document_prefix: str = "search_document: "

    # ── Voice transport
    voice_transport: Literal["smallwebrtc", "daily"] = "smallwebrtc"
    daily_api_key: SecretStr = SecretStr("")
    ice_servers_json: str = ""

    # ── App
    prompt_version: str = "v1"
    web_origin: str = "http://localhost:3000"
    demo_mode: bool = True
    max_voice_session_seconds: int = 300
    warmup_on_startup: bool = True
    rate_limit_per_minute: int = Field(default=60, ge=1)

    @field_validator("ice_servers_json")
    @classmethod
    def _valid_ice_json(cls, v: str) -> str:
        if v.strip():
            parsed = json.loads(v)
            if not isinstance(parsed, list):
                raise ValueError("ICE_SERVERS_JSON must be a JSON list")
        return v

    @property
    def llm_is_ollama(self) -> bool:
        return ":11434" in self.llm_base_url

    @property
    def stt_model_ref(self) -> str:
        """Resolved model reference for the configured STT provider."""
        if self.stt_provider == "local_whisper":
            return MLX_WHISPER_MODELS.get(self.stt_model, self.stt_model)
        return self.stt_model

    @property
    def all_local(self) -> bool:
        local_hosts = ("localhost", "127.0.0.1")
        return (
            any(h in self.llm_base_url for h in local_hosts)
            and self.stt_provider == "local_whisper"
            and self.tts_provider == "kokoro"
            and (self.embed_provider == "fastembed" or any(h in self.embed_base_url for h in local_hosts))
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
