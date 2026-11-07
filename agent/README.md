---
title: SmileDesk Agent
emoji: 🦷
colorFrom: green
colorTo: blue
sdk: docker
app_port: 8080
pinned: false
short_description: Pearl, the AI dental front desk (FastAPI + Pipecat API)
---

# SmileDesk agent

The API and voice server behind [SmileDesk](https://github.com/) (Pearl, the AI front desk of the fictional
Pearl Dental Care). This folder deploys as a Hugging Face Docker Space; the web app runs separately (Vercel).

- `GET /api/health`: service status (the web app's boot screen reads it)
- `POST /api/chat`: chat with Pearl (Server-Sent Events)
- `POST /api/offer`: browser voice calls (WebRTC)

Configuration is environment variables only (Space → Settings → Variables and secrets). See `docs/DEPLOY.md` in the
main repository.
