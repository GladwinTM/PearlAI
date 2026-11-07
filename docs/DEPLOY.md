# SmileDesk: Deployment (free tier)

A public demo link at **$0/month**, from personal accounts only (never a work email or company org).

| Part | Service (free tier) | Notes |
|---|---|---|
| Web app | **Vercel** Hobby | Root directory `web/` |
| Agent API + voice | **Hugging Face Space** (Docker, CPU basic: 2 vCPU, 16 GB) | Sleeps after ~48 h without visits; the keep-alive workflow pings it daily |
| Database | **Supabase** free project | Pauses after ~a week idle; same keep-alive ping |
| LLM | **Groq** free: `openai/gpt-oss-20b`, falling back to `gpt-oss-120b` and `qwen/qwen3.8-27b` | Each model has its own free quota (~8K tokens/min); ~10 model calls/min combined |
| Speech-to-text | **Groq** Whisper `whisper-large-v3-turbo` | Same Groq key |
| Text-to-speech, embeddings | Kokoro and fastembed **inside the agent** | No API, no key; models baked into the image |
| Voice connectivity | **Metered** Open Relay TURN | Needed: the Space can't take direct WebRTC traffic |

> Free tiers change often. If a quota disappears, every provider is swappable with env variables only.
> Expect pauses of 10–30 s when several people use Pearl at once: that's the free LLM quota, not a bug.

---

## 0. Before you start

- **Rotate any key that was ever pasted into a chat or a log** (Groq, Supabase secret key, TURN credential) before
  sharing the link.
- **Keep the project out of iCloud-synced folders** (Desktop/Documents with iCloud Drive): sync creates duplicate
  files such as `conftest 2.py` or `.git/index 2`. Moving it to e.g. `~/dev/smiledesk` avoids that.
- The repo's git identity is personal (`git config user.email` → your Gmail).

## 1. Database (Supabase)

Already done for this project (`supabase db push --remote --include-seed`, then the FAQ embedded with fastembed).
For a fresh project:

```bash
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push --remote --include-seed
# FAQ embeddings, with EMBED_PROVIDER=fastembed and the cloud URL/key in .env:
make ingest
```

Never run `supabase db reset` against the linked project: it wipes the remote database.

## 2. Push the code to GitHub

Create an **empty public** repo `smiledesk` on your personal GitHub, then from the repo root:

```bash
git remote add origin git@github.com:<you>/smiledesk.git
git push -u origin main
```

Check that no secrets are in the history (should print nothing):

```bash
git log -p | grep -iE "gsk_|sb_secret|service_role.*ey" | head
```

## 3. Agent on a Hugging Face Space

1. huggingface.co → **New Space** → name `smiledesk-agent`, SDK **Docker** (blank), hardware **CPU basic (free)**,
   visibility **Public** (a private Space's URL needs a login, so the website couldn't call it).
2. Space → **Settings → Variables and secrets** → add these as **secrets**:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API keys → secret key |
   | `LLM_API_KEY` | Groq API key |
   | `STT_API_KEY` | Groq API key (same one) |
   | `ICE_SERVERS_JSON` | The TURN JSON on one line, **without** the surrounding single quotes, e.g. `[{"urls":"stun:stun.relay.metered.ca:80"},{"urls":"turn:global.relay.metered.ca:80","username":"…","credential":"…"}]` |
   | `WEB_ORIGIN` | `http://localhost:3000` for now; the Vercel URL after step 4 |

   Everything else has hosted defaults in `agent/Dockerfile` (Groq model + fallbacks, fastembed, demo limits:
   60 voice calls/day, 4-minute calls, 2 at once). Override any of them here as a plain variable.
3. Push the `agent/` folder to the Space (it's a git repo of its own; the password is a Hugging Face access token
   with **write** permission):

   ```bash
   git remote add space https://huggingface.co/spaces/<hf-user>/smiledesk-agent
   git subtree push --prefix agent space main
   ```

   The first build takes ~10–15 minutes (dependencies + baking the Kokoro and fastembed models). Later pushes reuse
   cached layers.
4. Check: `https://<hf-user>-smiledesk-agent.hf.space/api/health` → `"status": "ok"` with all six components ready.

## 4. Web app on Vercel

1. vercel.com → **Add New → Project** → import `smiledesk` → **Root Directory: `web`** (framework: Next.js).
2. Environment variable: `NEXT_PUBLIC_AGENT_URL` = `https://<hf-user>-smiledesk-agent.hf.space` (public; never put a
   secret in a `NEXT_PUBLIC_*` variable). Optionally `NEXT_PUBLIC_GITHUB_URL` = your repo URL.
3. Deploy, then set the Space secret `WEB_ORIGIN` to the Vercel URL (e.g. `https://smiledesk.vercel.app`; comma-separate
   several). The Space restarts by itself.

## 5. Keep it awake

`.github/workflows/keepalive.yml` pings `/api/health` daily (keeps the Space and Supabase awake) and rebuilds the demo
fixtures so "Thursday is full" stays true relative to the current week. Enable it with a repository **variable**:
GitHub → Settings → Secrets and variables → Actions → **Variables** → `AGENT_URL` = the Space URL. Run it once by hand
(Actions → keepalive → Run workflow) to check.

## 6. Smoke test the live link

- The boot screen turns all green, then the landing page shows.
- Chat: a "things to try" chip books a slot; the calendar shows it; the Inspector shows the tool calls.
- Voice on desktop Chrome, Safari, and a phone on mobile data (this exercises TURN).
- "Reset demo" clears test bookings.

## 7. Protecting the free quotas

Already built in: per-IP rate limit (`RATE_LIMIT_PER_MINUTE`, keyed on the proxy-reported IP), at most 2 calls at once,
4-minute calls, 60 voice calls a day with a friendly "Pearl is resting" message, and LLM fallback across three free
Groq models. Still worth doing: usage alerts on each provider dashboard, and a short demo video in the README as a
fallback for days when a quota runs out.

---

## Optional: paid hosting (Fly.io)

`agent/fly.toml` deploys the same image to Fly.io (Mumbai, 2 GB, always on): no sleeping, roughly $10–15/month.
`fly launch --no-deploy` (keep the existing file) → `fly secrets set` with the same secrets → `fly deploy`.
Fly's trial lasts about 2 machine hours or 7 days, then it needs a card.
