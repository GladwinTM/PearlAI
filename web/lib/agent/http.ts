import "server-only";

import { settings } from "./config";

// Per-IP sliding-window rate limit. In memory per serverless instance: a soft guard for a demo, not a hard quota
// (Groq's own limits and the daily voice cap are the backstops).
const hits = new Map<string, number[]>();

export function clientIp(req: Request): string {
  // Vercel sets x-real-ip / x-forwarded-for itself (a client can't spoof the value Vercel writes).
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
}

/** Returns a 429 Response if this IP is over the limit, else null. */
export function rateLimited(req: Request, bucket: string): Response | null {
  const limit = settings().rateLimitPerMinute;
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return Response.json({ detail: "Too many requests. Please wait a moment." }, { status: 429, headers: { "retry-after": "20" } });
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear(); // keep memory bounded
  return null;
}

export const jsonError = (status: number, detail: string) => Response.json({ detail }, { status });
