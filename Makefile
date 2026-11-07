# SmileDesk: one-word commands for the whole stack. Everything runs locally.
#   make setup   install deps, start Supabase, pull Ollama models, embed the FAQ
#   make dev     run the agent API (:8000) and the web app (:3000)
#   make check   ruff, pyright, pytest, tsc, eslint

SHELL := /bin/bash
AGENT := cd agent && PYTHONPATH=src
SUPABASE := npx --no-install supabase
LLM_MODEL ?= qwen3:8b
EMBED_MODEL ?= nomic-embed-text

.PHONY: help setup deps db-start db-stop db-reset db-status models ingest dev agent web check lint typecheck test eval

help:
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-12s %s\n", $$1, $$2}'

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

dev: ## Run agent + web together (Ctrl-C stops both)
	@trap 'kill 0' EXIT; \
	  ($(AGENT) uv run uvicorn smiledesk.main:app --port 8000 --reload --reload-dir src) & \
	  (cd web && npm run dev) & \
	  wait

lint: ## Lint Python + TypeScript
	$(AGENT) uv run ruff check . && uv run ruff format --check .
	cd web && npm run lint

typecheck: ## Type-check Python + TypeScript
	$(AGENT) uv run pyright
	cd web && npx tsc --noEmit

test: ## Run the Python test suite (needs local Supabase + Ollama for db/ollama-marked tests)
	$(AGENT) uv run pytest -q

check: lint typecheck test ## Everything CI would run

eval: ## Run the eval suite (M5)
	$(AGENT) uv run python -m smiledesk.evals.runner --prompt $${PROMPT_VERSION:-v1}
