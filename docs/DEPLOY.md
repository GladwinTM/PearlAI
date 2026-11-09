# SmileDesk: Deployment (free, no server)

The live demo is **the web app alone on Vercel**: its API routes are the agent (TypeScript port in `web/lib/agent`),
and voice runs in the visitor's browser. Nothing to keep running, **$0/month**, from personal accounts only (never a
work email or company org).

| Part | Service (free tier) | Notes |
|---|---|---|
| Web app + agent API | **Vercel** Hobby | Root directory `web/`; `/api/chat`, `/api/transcribe`, … are serverless functions |
| Database + agent state | **Supabase** free project | Pauses after ~a week idle; the keep-alive workflow pings it daily |
| LLM | **Groq** free: `openai/gpt-oss-20b` → `gpt-oss-120b` → `qwen/qwen3.8-27b` fallbacks | Each model has its own free quota (~8K tokens/min); ~10 model calls/min combined |
| Speech-to-text | **Groq** Whisper `whisper-large-v3-turbo` | One request per utterance, from the browser via `/api/transcribe` |
| Turn detection + voice | **The visitor's browser**: Silero VAD and Kokoro-82M (Web Worker) | No server, no key. Kokoro's ~90 MB model downloads on the first call and is cached |
| FAQ search | Postgres full-text search (`search_kb`) | No embedding model needed |

> Free tiers change often. Every provider is swappable with environment variables only.
> Expect pauses of 10–30 s when several people use Pearl at once: that's the free LLM quota, not a bug.

The full local version (Python agent, Pipecat voice over WebRTC, Ollama, MLX Whisper) is `make dev-local`; it isn't
deployed. `agent/Dockerfile`, `agent/fly.toml` and `deploy/oracle/` remain for anyone who wants to host it on a server.

---

## 0. Before you start

- **Rotate any key that was ever pasted into a chat or a log** (Groq, Supabase secret key) before sharing the link.
- **Keep the project out of iCloud-synced folders** (Desktop/Documents with iCloud Drive): sync creates duplicate files
  such as `conftest 2.py` or `.git/index 2`. Moving it to e.g. `~/dev/smiledesk` avoids that.
- The repo's git identity is personal (`git config user.email` → your Gmail).

## 1. Database (Supabase)

Apply every migration (and the seed, the first time) to your project:

```bash
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push --remote --dry-run        # review what will be applied
npx supabase db push --remote --include-seed   # first time; later: without --include-seed
```

This project's database already has the schema, seed and lockdown; only `20261109000000_serverless_agent.sql`
(conversation state + full-text FAQ search) is new. Never run `supabase db reset` against the linked project: it wipes
the remote database.

## 2. Push the code to GitHub

Create an **empty public** repo `smiledesk` on your personal GitHub, then from the repo root:

```bash
git remote add origin git@github.com:<you>/smiledesk.git
git push -u origin main
```

Check that no secrets are in the history (should print 0):

```bash
git log -p | grep -cE "gsk_[A-Za-z0-9]{10}|sb_secret_[A-Za-z0-9]{6}"
```

## 3. Vercel

1. vercel.com → **Add New → Project** → import `smiledesk` → **Root Directory: `web`** (framework: Next.js).
2. **Environment variables** (Production). Server-only: none of these may be `NEXT_PUBLIC_*`.

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API keys → secret key |
   | `STT_API_KEY` | Groq API key (also used for the LLM unless `LLM_API_KEY` is set) |

   Optional: `LLM_API_KEY`, `LLM_MODEL`, `LLM_FALLBACK_MODELS`, `MAX_VOICE_CALLS_PER_DAY` (default 60),
   `RATE_LIMIT_PER_MINUTE` (default 30), `NEXT_PUBLIC_GITHUB_URL` (your repo URL, shown on the landing page).
   **Leave `NEXT_PUBLIC_AGENT_URL` unset**: set, it would point the site at a Python agent instead of its own API.
3. **Deploy.** Open `https://<project>.vercel.app/api/health`: `"status": "ok"` with all six components ready.

Function limits on Vercel Hobby are fine for this app: a chat turn takes ~1–3 s on Groq (`maxDuration` is 60 s) and
an utterance upload is a few hundred KB.

## 4. Keep it awake

`.github/workflows/keepalive.yml` pings `/api/health` daily (keeps the free Supabase project from pausing) and rebuilds
the demo fixtures so "Thursday is full" stays true relative to the current week. Enable it with a repository
**variable**: GitHub → Settings → Secrets and variables → Actions → **Variables** → `AGENT_URL` =
`https://<project>.vercel.app`. Run it once by hand (Actions → keepalive → Run workflow) to check.

## 5. Smoke test the live link

- The boot screen turns all green, then the landing page shows.
- Chat: a "things to try" chip books a slot; the calendar shows it; the Inspector shows the tool calls.
- Voice on desktop Chrome, Safari and a phone: Pearl greets you at once; the first call downloads her voice (~90 MB)
  while the browser's built-in voice fills in.
- "Reset demo" clears test bookings.
- From your machine, against the deployed site: `cd web && WEB_URL=https://<project>.vercel.app npx playwright test e2e/smoke.spec.ts`.

## 6. Protecting the free quotas

Built in: per-IP rate limits on chat, transcription and reset (`RATE_LIMIT_PER_MINUTE`), 4-minute voice calls,
60 voice calls a day with a friendly "Pearl is resting" message, and LLM fallback across three free Groq models. Still
worth doing: usage alerts on the Groq and Supabase dashboards, and a short demo video in the README as a fallback for
days when a quota runs out.
