# SmileDesk

**Meet Pearl, the AI front desk that never puts you on hold.**

SmileDesk is a voice-first AI receptionist for *Pearl Dental Care*, a fictional clinic in Coimbatore.
Patients can talk or chat with Pearl to book, reschedule and cancel appointments, ask clinic questions
(answered with RAG), and get escalated to a human when something sounds urgent.

Everything runs **locally** on an Apple Silicon Mac. There are no paid APIs and no cloud calls, and every model provider can be swapped through `.env`.

> 🚧 Work in progress. Milestone 1 (foundations) is done. Demo GIF, live link and eval results come with later milestones.

## Architecture

```
Browser (Next.js :3000) ──REST/SSE + WebRTC──▶ Agent (FastAPI + Pipecat :8000)
                                                 ├─ Supabase local (Postgres + pgvector)
                                                 ├─ Ollama: qwen3:8b (LLM), nomic-embed-text (embeddings)
                                                 └─ in-process: MLX Whisper (STT), Kokoro (TTS)
```

The browser never talks to Supabase. All data goes through the agent API, so the service-role key stays on the server and RLS stays locked down.

| Layer | Local default | Swap to (env only) |
|---|---|---|
| LLM | Ollama `qwen3:8b` (thinking off) | Any OpenAI-compatible API (Groq, OpenRouter, …) |
| STT | MLX Whisper `large-v3-turbo` | Groq Whisper |
| TTS | Kokoro-82M (`af_heart`) | (hosted option later) |
| Embeddings | Ollama `nomic-embed-text` (768-d) | `fastembed` CPU, or any OpenAI-compatible API |
| DB | Supabase local | Supabase cloud |

## Run locally

Prerequisites: Docker Desktop (running), [Ollama](https://ollama.com) (`ollama serve`), [uv](https://docs.astral.sh/uv/) and Node.js 20 or later.
Nothing is installed globally. The Supabase CLI is a project dev dependency.

```bash
make setup   # npm + uv deps, start Supabase, pull Ollama models, embed the FAQ
make dev     # agent API on :8000 and web on :3000
```

Open http://localhost:3000. The first boot downloads Whisper and Kokoro weights into local caches.

Locally you don't need a `.env`: the defaults are all local, and the agent reads the local Supabase key from `supabase status`.
To change providers, copy `.env.example` to `.env` and edit it.

| Command | What it does |
|---|---|
| `make db-reset` | Re-apply migrations + seed, re-embed the FAQ |
| `make ingest` | Re-embed the FAQ (after changing the embedding provider) |
| `make check` | ruff, pyright, pytest, tsc, eslint |

## Database highlights

- **Double booking is impossible** at the DB level, enforced by exclusion constraints on `(dentist, time range)` and `(patient, time range)`.
- Availability (`get_available_slots`) honours schedules, lunch, leave, service eligibility, appointment duration and the 6 PM new-patient cutoff.
- `reset_demo_fixtures()` rebuilds the demo scenarios (a full Thursday, a 60-minute gap that's too short for a root canal) relative to today.
- The public calendar (`get_calendar`) masks patient names ("Ravi K.").

## Repo layout

```
supabase/   migrations + seed (fictional data)
agent/      Python service (uv): FastAPI, providers, agent core, voice, evals
web/        Next.js app
docs/       DEPLOY.md
```
