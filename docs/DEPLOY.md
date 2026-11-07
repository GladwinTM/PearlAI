# SmileDesk: Deployment Guide (personal accounts)

The goal is a public link you can put on your resume that **stays up, loads fast, and costs close to nothing**, deployed entirely from **your personal accounts**.

> Free tiers and limits change often. Check each provider's current pricing page before you sign up. The numbers below are rough, not guarantees.

---

## 1. Personal identity first (do this before the first commit)

Use **one personal email** (your Gmail) for everything below. Never use your work email or a company GitHub org.

| Account | Used for |
|---|---|
| GitHub (personal) | Code, the keep-alive cron, linking to Vercel |
| Vercel (sign in with personal GitHub) | Frontend |
| Supabase (personal GitHub or Gmail) | Database |
| Groq | LLM + speech-to-text API (free tier) |
| Fly.io **or** Railway | The Python agent server |
| Daily (optional) | Voice transport in production |

**Set the repo's git identity locally**, so commits don't use your work identity:
```bash
cd smiledesk
git init
git config user.name "Gladwin TM"
git config user.email "<your-personal-gmail>"
```

**If this Mac also has a work GitHub account**, use a separate SSH key for the personal one:
```bash
ssh-keygen -t ed25519 -C "<your-personal-gmail>" -f ~/.ssh/id_ed25519_personal
```
Add to `~/.ssh/config`:
```
Host github-personal
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_personal
```
Then use `git@github-personal:<your-username>/smiledesk.git` as the remote.

> If this is a company laptop, check your company's device policy for personal projects. The safest option is to push from a personal machine.

---

## 2. What changes from local to deployed

| Layer | Local (now) | Deployed (recommended) | Why |
|---|---|---|---|
| Frontend | `next dev` | **Vercel Hobby** | Free and fast. Next.js is native there |
| Database | Supabase local | **Supabase free project** | Same migrations |
| LLM | Ollama `qwen3:8b` | **Groq** (OpenAI-compatible), a tool-calling model | Free tier, very low latency |
| STT | Local Whisper | **Groq Whisper** (`whisper-large-v3-turbo`) | No GPU needed on the server |
| TTS | Kokoro (local) | **Kokoro on CPU inside the agent container** | 82M params, runs on CPU |
| Embeddings | Ollama `nomic-embed-text` | **fastembed (CPU) nomic v1.5, 768 dims** in-process | Same dimension, no extra API. Re-run ingest |
| Voice transport | SmallWebRTC (peer-to-peer) | **Daily** (simplest) **or** SmallWebRTC + a TURN server | Cloud servers sit behind NAT, so plain peer-to-peer often fails |
| Agent server | `uvicorn` on your Mac | **Fly.io** or **Railway** (~$5/month) | Voice needs an always-on process with WebSockets/WebRTC. Serverless won't work |

> **Honest note on cost:** you can run the frontend, DB and APIs for free. A server that stays awake for real-time voice usually costs about $5/month. Free options exist (Oracle Cloud Always Free, Hugging Face Spaces), but they sleep or are fiddly to set up with WebRTC. For a resume link, $5/month for something that reliably works is worth it.

All of these are **env changes only**, because the app was built with swappable providers (see `.env.example`).

---

## 3. Step by step

### 3.1 Push the code
1. Create an **empty** repo `smiledesk` on your personal GitHub (public, so recruiters can read it).
2. Add the remote and push:
   ```bash
   git remote add origin git@github-personal:<your-username>/smiledesk.git
   ```
   ```bash
   git push -u origin main
   ```
3. Double-check that `.env` is in `.gitignore` and **no keys are committed**:
   ```bash
   git log -p | grep -iE "service_role|gsk_|sk-" | head
   ```

### 3.2 Supabase (database)
1. supabase.com → new project → region **Mumbai (ap-south-1)** → save the DB password in a password manager.
2. Link and push the schema:
   ```bash
   supabase login
   ```
   ```bash
   supabase link --project-ref <your-project-ref>
   ```
   ```bash
   supabase db push
   ```
3. Seed the data. `db push` doesn't run `seed.sql`. Copy the connection string from **Project Settings → Database**:
   ```bash
   psql "<connection-string>" -f supabase/seed.sql
   ```
   Never run `supabase db reset --linked` after launch, because it wipes the remote DB.
4. Copy the **Project URL** and **service_role key** (Project Settings → API) for the agent server. Don't put them anywhere else.

### 3.3 Groq (LLM + STT)
1. console.groq.com → create an API key.
2. Choose a model that's good at **tool calling** from Groq's current model list. Run your evals against it before switching (`make eval` with the Groq env).

### 3.4 Voice transport
**Option A: Daily (recommended, least hassle)**
1. dashboard.daily.co → create an API key and check the current free minutes.
2. Set `VOICE_TRANSPORT=daily` and `DAILY_API_KEY=...`.

**Option B: keep SmallWebRTC and add TURN**
1. Get TURN credentials from a provider with a free tier (e.g. Cloudflare Realtime TURN or Metered).
2. Set `ICE_SERVERS_JSON` on the server, and pass the same list to the client.

### 3.5 Agent server (Fly.io example; Railway works similarly)
1. Make sure `agent/Dockerfile` exists. Ask Claude Code: "add a production Dockerfile for the agent: Python 3.12 slim, uv, Kokoro + fastembed models downloaded at build time, uvicorn on $PORT".
2. Deploy:
   ```bash
   cd agent && fly launch --no-deploy
   ```
   Pick region **bom (Mumbai)** and a machine with **at least 1–2 GB RAM** (Kokoro + fastembed). Set `min_machines_running = 1` in `fly.toml` so it doesn't cold-start.
3. Set secrets. Each value goes in as a secret, never in `fly.toml`:
   ```bash
   fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... LLM_BASE_URL=https://api.groq.com/openai/v1 LLM_API_KEY=... LLM_MODEL=... JUDGE_BASE_URL=https://api.groq.com/openai/v1 JUDGE_API_KEY=... JUDGE_MODEL=... STT_PROVIDER=groq STT_API_KEY=... TTS_PROVIDER=kokoro EMBED_PROVIDER=fastembed VOICE_TRANSPORT=daily DAILY_API_KEY=... WEB_ORIGIN=https://<your-app>.vercel.app DEMO_MODE=true LLM_DISABLE_THINKING=true
   ```
   ```bash
   fly deploy
   ```
4. Embed the FAQ against the cloud DB (once, and after any embedding change):
   ```bash
   fly ssh console -C "python -m scripts.ingest_kb"
   ```
5. Check health:
   ```bash
   curl https://<your-agent>.fly.dev/api/health
   ```

### 3.6 Frontend (Vercel)
1. vercel.com → **Add New Project** → import `smiledesk` → **Root Directory: `web`**.
2. Env var: `NEXT_PUBLIC_AGENT_URL=https://<your-agent>.fly.dev`. Nothing secret goes in the frontend.
3. Deploy. Then set the server's `WEB_ORIGIN` to the final Vercel URL (or your custom domain) and redeploy the agent.

### 3.7 Keep it awake
Free Supabase projects **pause after about a week with no activity**. Add `.github/workflows/keepalive.yml`:
```yaml
name: keepalive
on:
  schedule: [{ cron: "0 3 * * *" }]   # daily, 08:30 IST
  workflow_dispatch:
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS https://<your-agent>.fly.dev/api/health
```
`/api/health` queries the DB, so this keeps both awake.

It's also worth having the agent run `reset_demo_fixtures()` once a day, so "Thursday full" and the other demos stay correct relative to today.

---

## 4. Protect your free tiers from abuse

A public voice demo can burn API quota fast. Before sharing the link:
- [ ] **Rate limit** per IP on `/api/chat` and on starting a voice session (already in the plan).
- [ ] **Max voice session** of 3–5 minutes (`MAX_VOICE_SESSION_SECONDS`).
- [ ] A **daily global cap** on voice sessions. When it's hit, show "Demo is resting for today, try chat or watch the video".
- [ ] Optional: **Cloudflare Turnstile** (free) before "Talk to Pearl" to block bots.
- [ ] Set **usage alerts or spend limits** on every provider dashboard.
- [ ] A **60-second demo video** on the landing page and in the README, as a fallback if quota runs out.

---

## 5. Pre-launch checklist
- [ ] Run `make eval` with the **production** providers. Expect results to differ from local Qwen; note both in the README.
- [ ] Voice works on desktop Chrome, Safari, and a phone on mobile data (this tests the TURN/Daily setup).
- [ ] Boot screen, error states and reset demo all work in production.
- [ ] No secrets in the repo, in `NEXT_PUBLIC_*` variables, or in client bundles (search the built JS for `service_role`).
- [ ] The README has the live link, a GIF, the architecture, eval results, and "run locally" steps.
- [ ] Add the live link and GitHub link to your resume and LinkedIn **Featured** section.

---

## 6. Optional
- **Custom domain** (e.g. `smiledesk.<yourname>.dev`): add it in Vercel, update `WEB_ORIGIN`.
- **Basic analytics:** Vercel Analytics (free tier) shows whether recruiters actually open the link.
