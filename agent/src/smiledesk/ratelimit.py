"""Tiny in-memory sliding-window rate limiter, per client IP.

Good enough for a single-process demo server; swap for Redis if the agent ever scales out.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from smiledesk.config import get_settings


class RateLimiter:
    def __init__(self, limit: int, window_s: float = 60.0) -> None:
        self.limit = limit
        self.window_s = window_s
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        q = self._hits[key]
        while q and now - q[0] >= self.window_s:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True


_limiter: RateLimiter | None = None


def client_ip(request: Request) -> str:
    """The visitor's IP, as reported by our own proxy (never a value the visitor can choose).

    Fly's proxy sets Fly-Client-IP. Otherwise use the LAST X-Forwarded-For entry (appended by the nearest
    proxy): the first entries are whatever the client sent, so trusting them would let anyone dodge the limit.
    """
    fly = request.headers.get("fly-client-ip")
    if fly:
        return fly.strip()
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


async def rate_limit(request: Request) -> None:
    """FastAPI dependency: 429 when an IP exceeds RATE_LIMIT_PER_MINUTE."""
    global _limiter
    if _limiter is None:
        _limiter = RateLimiter(get_settings().rate_limit_per_minute)
    if not _limiter.allow(client_ip(request)):
        raise HTTPException(status_code=429, detail="Too many requests. Please slow down and try again shortly.")
