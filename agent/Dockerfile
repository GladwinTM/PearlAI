# SmileDesk agent (FastAPI + Pipecat) for a CPU server, e.g. Fly.io.
# Hosted providers come from env/secrets (Mistral or Groq LLM, Groq STT, Supabase); Kokoro TTS and fastembed run
# in-process, and their model files are baked into the image so a restart never re-downloads them.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    FASTEMBED_CACHE_PATH=/models/fastembed

# onnxruntime (Kokoro, fastembed, Silero VAD) needs OpenMP.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /usr/local/bin/uv

RUN useradd --create-home --uid 1000 app && mkdir /models && chown app /models
WORKDIR /app

# Dependencies first (cached layer), then the app. MLX Whisper is macOS-only and is skipped here.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
COPY scripts ./scripts
RUN uv sync --frozen --no-dev

USER app
ENV PATH="/app/.venv/bin:$PATH"

# Bake the in-process models: Kokoro voice (~/.cache/pipecat/kokoro-onnx) and the fastembed model.
RUN python -c "from smiledesk.providers.tts import KokoroTTS; KokoroTTS('af_heart', 'kokoro-82m').warmup()" \
    && python -c "from fastembed import TextEmbedding; TextEmbedding('nomic-ai/nomic-embed-text-v1.5')"

# Non-secret hosted defaults (free tiers): Groq for the LLM with per-model fallbacks, Groq Whisper, in-process
# fastembed + Kokoro, demo limits. Secrets (API keys, Supabase URL/key, TURN) come from the platform's secret store.
ENV LLM_BASE_URL=https://api.groq.com/openai/v1 \
    LLM_MODEL=openai/gpt-oss-20b \
    LLM_DISABLE_THINKING=true \
    LLM_REASONING_EFFORT=low \
    LLM_FALLBACK_MODELS=openai/gpt-oss-120b,qwen/qwen3.8-27b:none \
    STT_PROVIDER=groq \
    STT_MODEL=whisper-large-v3-turbo \
    EMBED_PROVIDER=fastembed \
    EMBED_MODEL=nomic-ai/nomic-embed-text-v1.5 \
    DEMO_MODE=true \
    MAX_VOICE_SESSIONS=2 \
    MAX_VOICE_SESSION_SECONDS=240 \
    MAX_VOICE_CALLS_PER_DAY=60 \
    RATE_LIMIT_PER_MINUTE=30 \
    PORT=8080

EXPOSE 8080
CMD ["sh", "-c", "uvicorn smiledesk.main:app --host 0.0.0.0 --port ${PORT}"]
