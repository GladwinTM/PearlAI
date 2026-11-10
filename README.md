# SmileDesk

**Meet Pearl, the AI front desk that never puts you on hold.**

SmileDesk is a voice-first AI receptionist for *Pearl Dental Care*, a fictional clinic in Coimbatore.
Patients can talk or chat with Pearl to book, reschedule and cancel appointments, ask clinic questions
(answered with RAG), and get escalated to a human when something sounds urgent.

It comes in **two versions of the same product**:

- **Live demo, serverless and free.** The web app on Vercel *is* the backend: its API routes run Pearl's agent
  (TypeScript), voice runs in the visitor's browser, the LLM and speech-to-text are Groq's free tier. No server, $0/month.
- **Local, fully offline.** A Python agent with a Pipecat voice pipeline over WebRTC, Ollama `qwen3:8b`, MLX Whisper and
  Kokoro on an Apple Silicon Mac: no cloud calls at all.

Both share the prompt, the code guards, the database and the UI, and parity tests keep the two agents identical.

> 🚧 Work in progress. Milestones 1–4 plus the serverless version are done. Evals and the demo GIF come with M5.

![Talk page: live calendar, conversation and the Inspector](docs/screenshots/talk-desktop-light.png)

## Architecture

**Live demo (serverless):**
```
Browser ── mic → Silero VAD (WASM) ── utterance WAV ──▶ /api/transcribe ──▶ Groq Whisper
        ◀─ Kokoro TTS (Web Worker) ◀── streamed reply ── /api/chat: turn loop + 9 tools + guards ──▶ Groq gpt-oss-20b
           Pearl 3D · captions · Inspector · calendar      (Vercel functions)  └─▶ Supabase: data, agent state, FAQ search
```

**Local (full):**
```
Browser (Next.js :3000) ──REST/SSE + WebRTC──▶ Agent (FastAPI + Pipecat :8000)
                                                 ├─ Supabase local (Postgres + pgvector)
                                                 ├─ Ollama: qwen3:8b (LLM), nomic-embed-text (embeddings)
                                                 └─ in-process: MLX Whisper (STT), Kokoro (TTS)
```

Why two: a server-side voice pipeline needs an always-on server (~1.4 GB RAM), and no free host fits one. Moving the
audio work into the browser leaves only short request/response calls, which free serverless functions handle.

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
make setup       # npm + uv deps, start Supabase, pull Ollama models, embed the FAQ
make dev-local   # the full local version: Python agent on :8000 + web on :3000 (all offline)
make dev         # the serverless version on :3000 (needs a Groq key in .env: STT_API_KEY)
```

Open http://localhost:3000. The first local boot downloads Whisper and Kokoro weights into local caches.

`make dev-local` needs no `.env`: the defaults are all local, and the agent reads the local Supabase key from
`supabase status`. To change providers, copy `.env.example` to `.env` and edit it. Deploying the live demo:
[`docs/DEPLOY.md`](docs/DEPLOY.md).

| Command | What it does |
|---|---|
| `make db-reset` | Re-apply migrations + seed, re-embed the FAQ |
| `make ingest` | Re-embed the FAQ (after changing the embedding provider) |
| `make check` | ruff, pyright, pytest, tsc, eslint, vitest (incl. TypeScript ↔ Python parity tests) |
| `make e2e` | Playwright smoke tests in a real browser (landing → persona → chip → tool call; URL ↔ mode) |
| `make e2e-voice` | Browser voice end to end: a spoken question → VAD → Whisper → Pearl's spoken FAQ answer |
| `make sync-prompts` | Copy the agent's prompts into the serverless agent (after editing `prompts/*.md`) |
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
- **Safety backstop.** A regex detector runs before the LLM. If a red flag fires and the model doesn't escalate (or the model is down), the loop escalates (urgent) deterministically.
- **Confirm before booking.** A booking or move is refused unless Pearl's last question named exactly that slot ("Shall I book … at 9 AM?"): "the first one" after a list of options is a choice, not a yes.
- **Clinic facts come from the FAQ.** An answer about prices, insurance, parking or hours given without `get_clinic_info` is retracted and looked up.
- **Caller ID, confirmed at booking.** A known caller is greeted by name and never asked for their number; the number is confirmed in the booking question ("Shall I book … at 10 AM, on the number ending 0001?"), and `book_appointment` refuses until that question was asked. Only callers without caller ID are asked for their number.
- **Dates come from a table, not arithmetic.** The prompt carries a 14-day table that resolves "next Thursday" and "early next week".
- **Token-efficient tool I/O.** The model sees short handles (`P1`, `A1`, `priya`) and compact times instead of UUIDs, which means fewer generated tokens (lower latency) and no mis-copied ids.
- **Prompt-cache friendly.** The system prompt is identical across callers and stable within the hour, and caller ID is passed as data. Ollama's context is raised to 8k, because the 4k default silently truncated the prompt.

Try it from the terminal: `cd agent && uv run python scripts/chat_cli.py --persona ravi`.

## Voice

**Live demo: in the browser.** Silero VAD (WebAssembly) finds the end of each utterance, `/api/transcribe` sends it to
Groq Whisper, the reply streams from `/api/chat`, and Kokoro-82M speaks it in a Web Worker (WebGPU or WASM; the
browser's built-in voice fills in while its ~90 MB model loads, so the greeting is instant).

- **No lost requests.** Speech while Pearl talks only lowers her volume; she stops once it's confirmed as real words,
  not noise or her own echo. A new request never cancels the one in flight: the server finishes and saves every turn,
  even if the browser stops listening.
- **"Pearl is looking into it…"** shows while a request is being worked on, so callers don't talk over her.
- Phone numbers are read digit by digit and times naturally ("12:00 PM" → "twelve PM"), before synthesis.
- `make e2e-voice` plays a spoken question into a real browser as its microphone and checks the spoken FAQ answer.

**Local: Pipecat over WebRTC.**

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

- **Look.** Clean and product-like: Geist type, white cards with hairline borders and soft shadows, one strong blue accent and navy text, defined as oklch tokens in `web/app/globals.css`, light and dark, all text pairs WCAG AA.
- **Pearl is a 3D clay tooth** (`web/components/pearl`, three.js via react-three-fiber), built in code: her body is a signed distance field meshed in a Web Worker, with a glossy face, blush and noodle arms in cartoon gloves. Idle she floats and follows your cursor; listening she leans in and squashes with your mic; thinking, sparkles orbit her; speaking, her mouth moves with her voice. She winks with a peace sign when a booking is confirmed, looks worried for urgent symptoms and holds a heart when you say thanks. Lazy-loaded, paused off-screen, capped at 30 fps during calls, still poses for reduced motion, and an SVG poster when WebGL is missing. Phones use the browser's built-in voice instead of Kokoro (too heavy there), and on any device a sentence Kokoro hasn't produced within 4 s is spoken by the built-in voice. Every state is on `/dev/tooth` (dev only).
- **Boot screen.** An honest checklist that polls `/api/health` (database, LLM, embeddings, knowledge base, Whisper, Kokoro), with the fix shown if something is down.
- **Landing.** A two-column hero with Pearl on her stage, persona cards (each persona carries a caller ID, so nobody types a phone number), and "things to try" prompts that open a chat.
- **`/talk`.** Three panes: a live week calendar, the conversation, and the Inspector.
  - **Voice and chat are one conversation.** Switch mid-way: the voice call continues the chat (same tool context and history; Pearl says she has the chat in front of her), and chat continues after the call.
  - **Pearl** fills the voice stage; in chat a small static tooth by the composer reacts the same way. Messages pop in, and new bookings snap into the calendar.
  - **The Inspector** shows every tool call with its JSON result, guard and safety events, and a stacked latency bar per turn (STT / LLM first token / TTS first byte).
  - **The calendar** polls every 2 s during a conversation, jumps to the week of a new booking and animates it in. Fixtures are greyed and names are masked.
- Dark mode follows the system (with a toggle), the layout works on phones (the panes become tabs), `prefers-reduced-motion` is respected, and Lighthouse accessibility on the landing page and `/talk` is 100.
- In voice, captions show "12:00 PM" and "98000 00001" but Pearl *says* "twelve PM" and the number digit by digit: TTS-only transforms, because Kokoro reads "12:00" as "twelve zero zero" and a phone number as one big number.
- The URL follows the mode (`/talk?mode=voice` / `?mode=chat`), so links, the toggle and back/forward agree.

| Light | Dark |
|---|---|
| ![Landing, light](docs/screenshots/landing-desktop-light.png) | ![Landing, dark](docs/screenshots/landing-desktop-dark.png) |
| ![Talk on a phone, light](docs/screenshots/talk-mobile-light.png) | ![Talk on a phone, dark](docs/screenshots/talk-mobile-dark.png) |

## Repo layout

```
supabase/   migrations + seed (fictional data)
agent/      Python service (uv): FastAPI, providers, agent core, Pipecat voice, evals  ← local version
web/        Next.js app: UI, browser voice, and app/api + lib/agent (the serverless agent) ← live demo
deploy/     optional server hosting (Docker Compose + Caddy) for the Python agent
docs/       DEPLOY.md
```
