"""Text-to-speech providers: kokoro (Kokoro-82M via kokoro-onnx, local CPU/CoreML).

Model files live in the same cache Pipecat's KokoroTTSService uses (~/.cache/pipecat/kokoro-onnx),
so warming up here also pre-downloads them for the M3 voice pipeline.
"""

from __future__ import annotations

import asyncio
from functools import lru_cache
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

    def pipecat_service(self) -> Any:
        """A Pipecat TTS service for the voice pipeline."""
        ...


@lru_cache(maxsize=2)
def _shared_kokoro(model_path: str, voices_path: str) -> Any:
    """One Kokoro instance per process (≈300 MB), shared by warmup and every voice session."""
    from kokoro_onnx import Kokoro

    return Kokoro(model_path, voices_path)


def install_shared_kokoro() -> None:
    """Make Pipecat's KokoroTTSService reuse the shared instance instead of loading a copy per call.

    Pipecat constructs `Kokoro(model, voices)` inside the service's __init__; swapping the module-level name
    for the cached factory is the least invasive hook (no subclassing of private internals).
    """
    import pipecat.services.kokoro.tts as kokoro_module

    setattr(kokoro_module, "Kokoro", _shared_kokoro)  # noqa: B010 - deliberate module patch


LOCAL_TTS_STALL_S = 10.0


class KokoroTTS:
    is_local = True

    def __init__(self, voice: str, model_label: str) -> None:
        self.name = "kokoro"
        self.model = model_label
        self.voice = voice
        self._kokoro: Any = None

    def _load(self) -> Any:
        if self._kokoro is None:
            from pipecat.services.kokoro.tts import (  # reuse Pipecat's download + cache location
                KOKORO_CACHE_DIR,
                _ensure_model_files,  # pyright: ignore[reportPrivateUsage]
            )

            model_path = KOKORO_CACHE_DIR / "kokoro-v1.0.onnx"
            voices_path = KOKORO_CACHE_DIR / "voices-v1.0.bin"
            KOKORO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            _ensure_model_files(model_path, voices_path)
            kokoro = _shared_kokoro(str(model_path), str(voices_path))
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

    def pipecat_service(self) -> Any:
        from pipecat.services.kokoro.tts import KokoroTTSService

        from smiledesk.voice.text import speakable_numbers, speakable_times

        install_shared_kokoro()
        # TTS-level transforms change only what is synthesized; captions and the LLM context keep "12:00 PM".
        return KokoroTTSService(
            settings=KokoroTTSService.Settings(voice=self.voice),
            text_transforms=[("*", speakable_numbers), ("*", speakable_times)],
            # Kokoro synthesizes a whole sentence before the first byte. On a loaded laptop that can exceed Pipecat's
            # 3 s default, which reports "completed with no audio" and, three times in a row, marks the voice
            # unusable for the rest of the call. Slow is not broken: wait longer.
            stop_frame_timeout_s=LOCAL_TTS_STALL_S,
        )


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
