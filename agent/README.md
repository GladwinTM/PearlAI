# SmileDesk agent

The API and voice server behind SmileDesk (Pearl, the AI front desk of the fictional Pearl Dental Care).
FastAPI + Pipecat; the web app (`../web`) runs separately.

- `GET /api/health`: service status (the web app's boot screen reads it)
- `POST /api/chat`: chat with Pearl (Server-Sent Events)
- `POST /api/offer`: browser voice calls (WebRTC)

Run locally with `make dev` from the repo root. Deploy with Docker (`Dockerfile`; hosted defaults in `hosted.env`,
overridden by the server's `.env`). See `../docs/DEPLOY.md`.
