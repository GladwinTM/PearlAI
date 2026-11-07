"""Text-to-speech providers: kokoro (Kokoro-82M via kokoro-onnx, local CPU/CoreML).

Model files live in the same cache Pipecat's KokoroTTSService uses (~/.cache/pipecat/kokoro-onnx),
so warming up here also pre-downloads them for the M3 voice pipeline.
"""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

import numpy as np

from smiledesk.config import Settings, get_settings


class TTSProvider(Protocol):
    name: str
    model: str
    voice: str
    is_local: bool

    def warmup(self) -> None: ...

    async def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        """Returns (mono float32 samples, sample_rate)."""
        ...


class KokoroTTS:
    is_local = True

    def __init__(self, voice: str, model_label: str) -> None:
        self.name = "kokoro"
        self.model = model_label
        self.voice = voice
        self._kokoro: Any = None

    def _load(self) -> Any:
        if self._kokoro is None:
            from kokoro_onnx import Kokoro
            from pipecat.services.kokoro.tts import (  # reuse Pipecat's download + cache location
                KOKORO_CACHE_DIR,
                _ensure_model_files,  # pyright: ignore[reportPrivateUsage]
            )

            model_path = KOKORO_CACHE_DIR / "kokoro-v1.0.onnx"
            voices_path = KOKORO_CACHE_DIR / "voices-v1.0.bin"
            KOKORO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            _ensure_model_files(model_path, voices_path)
            kokoro = Kokoro(str(model_path), str(voices_path))
            if self.voice not in kokoro.voices:
                raise ValueError(f"TTS_VOICE '{self.voice}' is not a Kokoro voice")
            self._kokoro = kokoro
        return self._kokoro

    def warmup(self) -> None:
        self._load().create("Hello.", voice=self.voice, lang="en-us")

    async def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        def _run() -> tuple[np.ndarray, int]:
            samples, sr = self._load().create(text, voice=self.voice, lang="en-us")
            return samples, sr

        return await asyncio.to_thread(_run)


_tts: TTSProvider | None = None


def get_tts(settings: Settings | None = None) -> TTSProvider:
    global _tts
    if _tts is not None and settings is None:
        return _tts
    s = settings or get_settings()
    tts: TTSProvider
    if s.tts_provider == "kokoro":
        tts = KokoroTTS(s.tts_voice, s.tts_model)
    else:  # pragma: no cover
        raise ValueError(f"Unknown TTS_PROVIDER: {s.tts_provider}")
    if settings is None:
        _tts = tts
    return tts
