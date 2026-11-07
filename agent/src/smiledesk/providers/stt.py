"""Speech-to-text providers: local_whisper (MLX Whisper on Apple Silicon) | groq (hosted Whisper).

M1 provides load/warmup + a plain `transcribe()`; M3 adds the Pipecat service factory on top,
so the voice pipeline and these checks share the same model choice.
"""

from __future__ import annotations

import asyncio
import io
import wave
from typing import Any, Protocol

import numpy as np

from smiledesk.config import Settings, get_settings

SAMPLE_RATE = 16_000


class STTProvider(Protocol):
    name: str
    model: str
    is_local: bool

    def warmup(self) -> None: ...

    async def transcribe(self, audio: np.ndarray) -> str:
        """`audio`: mono float32 PCM at 16 kHz in [-1, 1]."""
        ...

    def pipecat_service(self) -> Any:
        """A Pipecat STT service for the voice pipeline."""
        ...


class LocalWhisperSTT:
    """MLX Whisper. Weights are downloaded from Hugging Face on first load, then cached locally."""

    is_local = True

    def __init__(self, model_ref: str) -> None:
        self.name = "local_whisper"
        self.model = model_ref
        self._loaded = False

    def _mlx(self) -> Any:
        import mlx_whisper  # pyright: ignore[reportMissingTypeStubs]

        return mlx_whisper

    def warmup(self) -> None:
        # Transcribing a short silence forces the weights to download, load and compile.
        self._mlx().transcribe(np.zeros(SAMPLE_RATE // 2, dtype=np.float32), path_or_hf_repo=self.model, language="en")
        self._loaded = True

    async def transcribe(self, audio: np.ndarray) -> str:
        def _run() -> str:
            out = self._mlx().transcribe(
                audio.astype(np.float32), path_or_hf_repo=self.model, language="en", temperature=0.0
            )
            return str(out.get("text", "")).strip()

        return await asyncio.to_thread(_run)

    def pipecat_service(self) -> Any:
        from pipecat.services.whisper.stt import WhisperSTTServiceMLX
        from pipecat.transcriptions.language import Language

        # Same model id as warmup, so mlx_whisper's in-process model cache is reused (no second load).
        return WhisperSTTServiceMLX(
            settings=WhisperSTTServiceMLX.Settings(model=self.model, language=Language.EN, no_speech_prob=0.6)
        )


class GroqSTT:
    """Hosted Whisper via Groq's OpenAI-compatible audio API (for deployment)."""

    is_local = False

    def __init__(self, base_url: str, api_key: str, model: str) -> None:
        from openai import AsyncOpenAI

        self.name = "groq"
        self.model = model
        self._api_key = api_key
        self._client = AsyncOpenAI(base_url=base_url, api_key=api_key or "unused", max_retries=1, timeout=60)

    def warmup(self) -> None:
        if not self._api_key:
            raise RuntimeError("STT_PROVIDER=groq needs STT_API_KEY")

    async def transcribe(self, audio: np.ndarray) -> str:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
        resp = await self._client.audio.transcriptions.create(
            model=self.model, file=("audio.wav", buf.getvalue()), language="en"
        )
        return resp.text.strip()

    def pipecat_service(self) -> Any:
        try:
            from pipecat.services.groq.stt import GroqSTTService  # pyright: ignore[reportMissingImports]
        except ImportError as e:  # pragma: no cover - optional extra
            raise RuntimeError('Voice with STT_PROVIDER=groq needs: uv add "pipecat-ai[groq]"') from e
        return GroqSTTService(api_key=self._api_key, model=self.model)


_stt: STTProvider | None = None


def get_stt(settings: Settings | None = None) -> STTProvider:
    global _stt
    if _stt is not None and settings is None:
        return _stt
    s = settings or get_settings()
    stt: STTProvider
    if s.stt_provider == "local_whisper":
        stt = LocalWhisperSTT(s.stt_model_ref)
    elif s.stt_provider == "groq":
        stt = GroqSTT(s.stt_base_url, s.stt_api_key.get_secret_value(), s.stt_model_ref)
    else:  # pragma: no cover
        raise ValueError(f"Unknown STT_PROVIDER: {s.stt_provider}")
    if settings is None:
        _stt = stt
    return stt
