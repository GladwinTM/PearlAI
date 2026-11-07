# SmileDesk

**Meet Pearl, the AI front desk that never puts you on hold.**

SmileDesk is a voice-first AI receptionist for *Pearl Dental Care*, a fictional clinic in Coimbatore.
Patients can talk or chat with Pearl to book, reschedule and cancel appointments, ask clinic questions
(answered with RAG), and get escalated to a human when something sounds urgent.

Everything runs **locally** on an Apple Silicon Mac. There are no paid APIs and no cloud calls, and every model provider can be swapped through `.env`.

> 🚧 Work in progress. Milestones 1–4 (foundations, agent + chat, voice, UI) are done. Evals and the demo GIF come with M5.

![Talk page: live calendar, conversation and the Inspector](docs/screenshots/talk-desktop-light.png)

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
| STT | MLX Whisper `small.en` | Groq Whisper |
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
| `make e2e` | Playwright smoke test in a real browser (landing → persona → chip → tool call in the Inspector) |
| `make screenshots` | Desktop + mobile, light + dark, into `docs/screenshots/` |
| `make lighthouse` | Lighthouse accessibility / best practices / SEO for the landing page |

## Database highlights

- **Double booking is impossible** at the DB level, enforced by exclusion constraints on `(dentist, time range)` and `(patient, time range)`.
- Availability (`get_available_slots`) honours schedules, lunch, leave, service eligibility, appointment duration and the 6 PM new-patient cutoff.
- `reset_demo_fixtures()` rebuilds the demo scenarios (a full Thursday, a 60-minute gap that's too short for a root canal) relative to today.
- The public calendar (`get_calendar`) masks patient names ("Ravi K.").

## Agent design: making a local 8B model reliable

A small local model will happily invent slots, guess phone numbers and "check" without calling a tool.
Prompt rules help, but the important guarantees are enforced in code:

- **No invented slots.** `book_appointment` and `reschedule_appointment` only accept a slot that `check_availability` returned in this conversation, and the database rejects double booking anyway.
- **Grounding check.** Every clock time Pearl says must come from a tool result (or the caller). If it doesn't, the reply is retracted in the UI and the model is told to check availability first.
- **No guessed identities.** `lookup_patient` only accepts numbers the caller actually said (or the caller ID).
- **Writes are scoped.** Pearl can only book, change or cancel for patients identified in this conversation.
- **"Let me check…" with no tool call** gets a nudge to actually call the tool.
- **Safety backstop.** A regex detector runs before the LLM. If a red flag fires and the model doesn't escalate, the loop escalates (urgent) deterministically.
- **Dates come from a table, not arithmetic.** The prompt carries a 14-day table that resolves "next Thursday" and "early next week".
- **Token-efficient tool I/O.** The model sees short handles (`P1`, `A1`, `priya`) and compact times instead of UUIDs, which means fewer generated tokens (lower latency) and no mis-copied ids.
- **Prompt-cache friendly.** The system prompt is identical across callers and stable within the hour, and caller ID is passed as data. Ollama's context is raised to 8k, because the 4k default silently truncated the prompt.

Try it from the terminal: `cd agent && uv run python scripts/chat_cli.py --persona ravi`.

## Voice

```
browser mic ─WebRTC─▶ Whisper (MLX) ─▶ safety guard ─▶ VAD/turns ─▶ qwen3:8b + tools ─▶ claim guard ─▶ Kokoro ─WebRTC─▶ speaker
```

- **Pipecat** pipeline over SmallWebRTC (peer-to-peer). The transport is created in one factory on each side, so moving to Daily for deployment is a config change.
- **Same brain as chat.** Voice uses the same prompt, tool schemas and executors (and therefore the same guards).
- **Voice-specific guards.** Spoken words can't be retracted, so checks run *before* TTS:
  - Emoji and markdown are stripped.
  - A sentence that claims "your appointment is booked/cancelled/moved" is replaced with a confirmation question unless a write tool actually succeeded.
  - The safety backstop escalates on the transcript itself, before the LLM runs.
- **Latency work.** STT is `small.en` (about 130 ms per utterance; large-v3-turbo takes about 400 ms and 1.2 GB more RAM). The first clause of each reply is sent to TTS at the first comma, so Pearl starts speaking while the LLM is still writing. A filler line covers tool rounds.
- **Measured, not faked.** Every turn reports STT, LLM first token, TTS first byte and voice-to-voice to the UI. `make voice-probe` runs a headless WebRTC caller that *speaks* to Pearl (Kokoro, different voice) and measures latency at the caller's ear, including barge-in.

Measured on an M5 / 16 GB under heavy memory pressure (Ollama, Docker and an IDE running; 12+ GB swap):

| | Median | Range |
|---|---|---|
| Simple turn, end of speech → Pearl audible (server) | **1.8 s** | 1.1–2.9 s |
| Same, at the caller's ear (+ 0.5 s silence window, network) | ~2.4 s | |
| Tool turn: "One moment" audible / real answer starts | 2–4 s / 6–9 s | |
| Barge-in: caller starts talking → Pearl silent | ~0.6 s | 0.15–0.65 s |

The bottleneck is the 8B model's generation speed while the machine is swapping. A tool turn needs two LLM rounds.

## The UI

- **Boot screen.** An honest checklist that polls `/api/health` (database, LLM, embeddings, knowledge base, Whisper, Kokoro), with the fix shown if something is down.
- **Landing.** A canvas "pearl" orb, a persona switcher (each persona carries a caller ID, so nobody types a phone number), and "things to try" chips that open a chat.
- **`/talk`.** Three panes: a live week calendar, the conversation, and the Inspector.
  - **Voice and chat are one conversation.** Switch mid-way: the voice call continues the chat (same tool context and history; Pearl says she has the chat in front of her), and chat continues after the call.
  - **The orb** breathes when idle, follows your mic level while listening, swirls while thinking and follows Pearl's voice while she speaks.
  - **The Inspector** shows every tool call with its JSON result, guard and safety events, and a stacked latency bar per turn (STT / LLM first token / TTS first byte).
  - **The calendar** polls every 2 s during a conversation, jumps to the week of a new booking and animates it in. Fixtures are greyed and names are masked.
- Dark mode follows the system (with a toggle), the layout works on phones (the panes become tabs), `prefers-reduced-motion` is respected, and Lighthouse accessibility on the landing page and `/talk` is 100.
- In voice, captions show "12:00 PM" but Pearl *says* "twelve PM": a TTS-only transform rewrites clock times, because Kokoro reads "12:00" as "twelve zero zero".

| Light | Dark |
|---|---|
| ![Landing, light](docs/screenshots/landing-desktop-light.png) | ![Landing, dark](docs/screenshots/landing-desktop-dark.png) |
| ![Talk on a phone, light](docs/screenshots/talk-mobile-light.png) | ![Talk on a phone, dark](docs/screenshots/talk-mobile-dark.png) |

## Repo layout

```
supabase/   migrations + seed (fictional data)
agent/      Python service (uv): FastAPI, providers, agent core, voice, evals
web/        Next.js app
docs/       DEPLOY.md
```
