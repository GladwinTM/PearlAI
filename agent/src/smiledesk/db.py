"""Supabase client (service role). Server-side only; this key never reaches the browser."""

from __future__ import annotations

import re
import subprocess
from functools import lru_cache
from typing import Any, cast

from loguru import logger
from supabase import Client, create_client

from smiledesk.config import REPO_ROOT, get_settings


class DatabaseNotConfiguredError(RuntimeError):
    pass


def rows(res: Any) -> list[dict[str, Any]]:
    """Typed view of a PostgREST response that returns a set of rows."""
    return cast(list[dict[str, Any]], res.data or [])


def row(res: Any) -> dict[str, Any]:
    """Typed view of a PostgREST response that returns one row/object (rpc returning a record or jsonb)."""
    return cast(dict[str, Any], res.data or {})


def _is_local(url: str) -> bool:
    return "127.0.0.1" in url or "localhost" in url


def _local_service_role_key() -> str:
    """For local dev only: read the key from `supabase status`, so no .env file is required."""
    try:
        out = subprocess.run(
            ["npx", "--no-install", "supabase", "status", "-o", "env"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError) as e:
        raise DatabaseNotConfiguredError(
            "SUPABASE_SERVICE_ROLE_KEY is empty and local Supabase isn't running. Start it with `make db-start`."
        ) from e
    m = re.search(r'^SERVICE_ROLE_KEY="?([^"\n]+)"?$', out, re.MULTILINE)
    if not m:
        raise DatabaseNotConfiguredError("Could not read SERVICE_ROLE_KEY from `supabase status`.")
    logger.info("Using the local Supabase service-role key from `supabase status`.")
    return m.group(1)


@lru_cache
def get_db() -> Client:
    s = get_settings()
    key = s.supabase_service_role_key.get_secret_value()
    if not key:
        if not _is_local(s.supabase_url):
            raise DatabaseNotConfiguredError("SUPABASE_SERVICE_ROLE_KEY is required for a non-local SUPABASE_URL.")
        key = _local_service_role_key()
    return create_client(s.supabase_url, key)
