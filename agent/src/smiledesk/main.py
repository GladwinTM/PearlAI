"""SmileDesk agent API: FastAPI app, CORS, startup warmup."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from smiledesk.api import calendar, demo, health
from smiledesk.config import get_settings
from smiledesk.warmup import run_warmup


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    s = get_settings()
    task: asyncio.Task[None] | None = None
    if s.warmup_on_startup:
        # Background, so /api/health can report progress to the boot screen while models load.
        task = asyncio.create_task(run_warmup())
    logger.info(f"SmileDesk agent up. CORS origin: {s.web_origin}")
    yield
    if task and not task.done():
        task.cancel()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="SmileDesk Agent", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in s.web_origin.split(",") if o.strip()],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    app.include_router(health.router)
    app.include_router(calendar.router)
    app.include_router(demo.router)
    return app


app = create_app()
