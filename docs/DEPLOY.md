# SmileDesk: Deployment (free tier)

A public demo link at **$0/month**, from personal accounts only (never a work email or company org).

| Part | Service (free tier) | Notes |
|---|---|---|
| Web app | **Vercel** Hobby | Root directory `web/` |
| Agent API + voice | **Oracle Cloud Always Free** VM (Ampere A1, Ubuntu) | Docker Compose: agent + Caddy (automatic HTTPS) |
| Database | **Supabase** free project | Pauses after ~a week idle; the keep-alive workflow pings it daily |
| LLM | **Groq** free: `openai/gpt-oss-20b`, falling back to `gpt-oss-120b` and `qwen/qwen3.8-27b` | Each model has its own free quota (~8K tokens/min); ~10 model calls/min combined |
| Speech-to-text | **Groq** Whisper `whisper-large-v3-turbo` | Same Groq key |
| Text-to-speech, embeddings | Kokoro and fastembed **inside the agent** | No API, no key; models baked into the image |
| Voice connectivity | **Metered** Open Relay TURN | Helps callers behind strict NATs and mobile networks |

> Free tiers change often. Every provider is swappable with env variables only.
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

Check that no secrets are in the history (should print 0):

```bash
git log -p | grep -cE "gsk_[A-Za-z0-9]{10}|sb_secret_[A-Za-z0-9]{6}"
```

## 3. Agent on an Oracle Cloud Always Free VM

### 3.1 Account and VM (Oracle console)

1. Sign up at oracle.com/cloud/free with your personal email. The card is for identity verification; Oracle says
   Always Free resources aren't charged unless you upgrade. **Your home region can't be changed later**: pick one near
   your users with Ampere capacity (e.g. India West (Mumbai) or India South (Hyderabad)).
2. **Compute → Instances → Create instance**
   - Image: **Canonical Ubuntu 24.04** (the aarch64 build is picked automatically for Ampere).
   - Shape: **VM.Standard.A1.Flex** (Ampere), **2 OCPU, 12 GB** memory: within the Always Free allowance
     (reported as 4 OCPU / 24 GB, or 2 / 12 for some new accounts) and plenty for the agent (~1.4 GB).
   - Networking: create a new VCN with a **public subnet**, and **assign a public IPv4 address**.
   - SSH keys: upload your public key (`~/.ssh/id_ed25519.pub`; create one with `ssh-keygen -t ed25519` if needed).
   - "Out of capacity"? Try another availability domain, or retry later; free Ampere capacity comes and goes.
3. **Open ports 80 and 443**: Networking → Virtual cloud networks → your VCN → Security → the subnet's security
   list → **Add ingress rules**: source `0.0.0.0/0`, TCP, destination ports `80` and `443`.
   (Port 22 is open by default. `setup.sh` opens the VM's own firewall too.)
4. Note the instance's **public IP**.

> **Idle reclamation:** Oracle may reclaim *Always Free* instances that stay nearly idle for 7 days (low CPU, network
> and memory use). If that happens, recreating the VM and re-running `setup.sh` takes ~15 minutes. Upgrading the
> account to Pay As You Go stops reclamation and still bills nothing within the Always Free limits, but anything
> outside those limits would then be charged.

### 3.2 Deploy (on the VM)

```bash
ssh ubuntu@<public-ip>
git clone https://github.com/<you>/smiledesk.git && cd smiledesk
nano .env            # the server's secrets, see below
bash deploy/oracle/setup.sh
```

The server's `.env` (only these; everything else has hosted defaults in `agent/hosted.env`, which this file overrides):

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<Supabase secret key>
LLM_API_KEY=<Groq key>
JUDGE_API_KEY=<Groq key>
STT_API_KEY=<Groq key>
ICE_SERVERS_JSON='[{"urls":"stun:stun.relay.metered.ca:80"},{"urls":"turn:global.relay.metered.ca:80","username":"…","credential":"…"}]'
WEB_ORIGIN=http://localhost:3000
```

`setup.sh` installs Docker, opens ports 80/443 in the VM firewall, sets `AGENT_DOMAIN` to `<ip-with-dashes>.sslip.io`
(a free hostname that points at the IP, so Caddy can get a Let's Encrypt certificate without buying a domain), builds
the image (~10 minutes the first time) and starts the agent behind Caddy. It ends by printing the health check:

```
✓ Agent is live at https://<ip-with-dashes>.sslip.io
```

**Updating later:** `git push` from your Mac, then on the VM `bash deploy/oracle/setup.sh` (it pulls and rebuilds).
Logs: `cd deploy/oracle && sudo docker compose logs -f agent`.

## 4. Web app on Vercel

1. vercel.com → **Add New → Project** → import `smiledesk` → **Root Directory: `web`** (framework: Next.js).
2. Environment variable: `NEXT_PUBLIC_AGENT_URL` = `https://<ip-with-dashes>.sslip.io` (public; never put a secret in a
   `NEXT_PUBLIC_*` variable). Optionally `NEXT_PUBLIC_GITHUB_URL` = your repo URL.
3. Deploy. Then on the VM set `WEB_ORIGIN` in `.env` to the Vercel URL (e.g. `https://smiledesk.vercel.app`;
   comma-separate several) and re-run `bash deploy/oracle/setup.sh`.

## 5. Keep it awake

`.github/workflows/keepalive.yml` pings `/api/health` daily (keeps Supabase awake) and rebuilds the demo fixtures so
"Thursday is full" stays true relative to the current week. Enable it with a repository **variable**: GitHub →
Settings → Secrets and variables → Actions → **Variables** → `AGENT_URL` = `https://<ip-with-dashes>.sslip.io`. Run it
once by hand (Actions → keepalive → Run workflow) to check.

## 6. Smoke test the live link

- The boot screen turns all green, then the landing page shows.
- Chat: a "things to try" chip books a slot; the calendar shows it; the Inspector shows the tool calls.
- Voice on desktop Chrome, Safari, and a phone on mobile data (this exercises TURN).
- "Reset demo" clears test bookings.

## 7. Protecting the free quotas

Already built in: per-IP rate limit (`RATE_LIMIT_PER_MINUTE`, using the proxy-reported IP), at most 2 calls at once,
4-minute calls, 60 voice calls a day with a friendly "Pearl is resting" message, and LLM fallback across three free
Groq models. Still worth doing: usage alerts on each provider dashboard, and a short demo video in the README as a
fallback for days when a quota runs out.

---

## Alternatives

- **Fly.io** (paid, ~$10–15/month, always on): `agent/fly.toml` deploys the same image. `fly launch --no-deploy`
  (keep the file) → `fly secrets set` with the server `.env` values → `fly deploy`.
- **Any Linux VM** (another cloud, a home server): `deploy/oracle/setup.sh` works on any Ubuntu box with ports 80/443
  open.
