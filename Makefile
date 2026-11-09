# SmileDesk: one-word commands for the whole stack.
#   make setup      install deps, start Supabase, pull Ollama models, embed the FAQ
#   make dev        the web app with the serverless agent (:3000) — what gets deployed (Groq + Supabase from .env)
#   make dev-local  the full local version: Python agent + Pipecat voice (:8000, Ollama/Whisper/Kokoro) and the web app
#   make check      ruff, pyright, pytest, tsc, eslint, vitest

SHELL := /bin/bash
AGENT := cd agent && PYTHONPATH=src
SUPABASE := npx --no-install supabase
LLM_MODEL ?= qwen3:8b
EMBED_MODEL ?= nomic-embed-text

.PHONY: help setup deps db-start db-stop db-reset db-status models ingest dev dev-local agent web check lint typecheck test eval voice-probe e2e e2e-voice screenshots lighthouse sync-prompts

help:
	@grep -E '^[a-z0-9-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-12s %s\n", $$1, $$2}'

setup: deps db-start models ingest ## First-time setup: deps, DB, models, embeddings
	@echo "✓ Setup done. Run: make dev"

deps: ## Install project-local dependencies (uv + npm)
	npm install
	$(AGENT) uv sync
	cd web && npm install

db-start: ## Start local Supabase (Docker must be running)
	@docker info >/dev/null 2>&1 || { echo "Docker isn't running. Start Docker Desktop first."; exit 1; }
	$(SUPABASE) start

db-stop: ## Stop local Supabase
	$(SUPABASE) stop

db-status: ## Show local Supabase URLs
	$(SUPABASE) status

db-reset: ## Re-apply migrations + seed (wipes local data), then re-embed the FAQ
	$(SUPABASE) db reset
	$(MAKE) ingest

models: ## Pull the Ollama models (needs `ollama serve` running)
	@curl -sf http://localhost:11434/api/version >/dev/null || { echo "Ollama isn't running. Start it with: ollama serve"; exit 1; }
	ollama pull $(LLM_MODEL)
	ollama pull $(EMBED_MODEL)

ingest: ## Embed the FAQ documents into pgvector
	$(AGENT) uv run python scripts/ingest_kb.py

agent: ## Run only the agent API on :8000
	$(AGENT) uv run uvicorn smiledesk.main:app --port 8000 --reload --reload-dir src

web: ## Run only the web app on :3000
	cd web && npm run dev

dev: ## Web app + serverless agent on :3000 (the deployed version; uses .env: Groq, Supabase)
	cd web && NEXT_PUBLIC_AGENT_URL= npm run dev

dev-local: ## Full local version: Python agent (:8000, Pipecat voice) + web app pointed at it (Ctrl-C stops both)
	@trap 'kill 0' EXIT; \
	  ($(AGENT) uv run uvicorn smiledesk.main:app --port 8000 --reload --reload-dir src) & \
	  (cd web && NEXT_PUBLIC_AGENT_URL=http://localhost:8000 npm run dev) & \
	  wait

lint: ## Lint Python + TypeScript
	$(AGENT) uv run ruff check . && uv run ruff format --check .
	cd web && npm run lint

typecheck: ## Type-check Python + TypeScript
	$(AGENT) uv run pyright
	cd web && npx tsc --noEmit

test: ## Python + TypeScript tests (DB tests need local Supabase: make db-start)
	$(AGENT) uv run pytest -q
	cd web && npm test

sync-prompts: ## Copy agent prompts (agent/src/smiledesk/agent/prompts/*.md) into the web app's serverless agent
	cd web && npm run sync-prompts

check: lint typecheck test ## Everything CI would run

voice-probe: ## Headless voice test: speaks to Pearl over WebRTC and reports real latency (agent must be running)
	$(AGENT) uv run python scripts/voice_probe.py --persona ravi --barge-in "Hello, good afternoon." "What are your opening hours on Saturday?" "I need a checkup next Wednesday afternoon." "Thanks, how much does a cleaning cost?"

e2e: ## Playwright smoke tests in a real browser (starts the web app if needed)
	cd web && npm run test:e2e

e2e-voice: ## Browser voice end to end: a spoken question → VAD → Groq Whisper → Pearl's spoken answer (uses Groq quota)
	cd web && npm run test:voice

screenshots: ## Desktop + mobile, light + dark screenshots into docs/screenshots
	cd web && npm run screenshots

lighthouse: ## Lighthouse accessibility/best-practices/SEO for the landing page (web must be running)
	cd web && npm run lighthouse

eval: ## Run the eval suite (M5)
	$(AGENT) uv run python -m smiledesk.evals.runner --prompt $${PROMPT_VERSION:-v1}
