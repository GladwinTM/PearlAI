import "server-only";

import OpenAI from "openai";

import { settings } from "./config";

// OpenAI-compatible client (Groq by default) with per-model fallback on HTTP 429, like providers/llm.py.
// Free tiers rate-limit per model, so the same request is retried on the next model before the SDK sees the 429.

export function parseFallbacks(spec: string): [string, string | null][] {
  const efforts = new Set(["none", "low", "medium", "high", "default"]);
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const i = item.lastIndexOf(":");
      const model = i > 0 ? item.slice(0, i) : "";
      const effort = i > 0 ? item.slice(i + 1) : "";
      return model && efforts.has(effort) ? [model, effort] : [item, null];
    });
}

/** fetch wrapper: on 429 from /chat/completions, resend the same body with the next model. */
export function fallbackFetch(fallbacks: [string, string | null][], inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!fallbacks.length || init?.method !== "POST" || !url.endsWith("/chat/completions") || typeof init.body !== "string")
      return inner(input, init);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const primary = String(body.model);
    const attempts: [string, string | null | undefined][] = [[primary, body.reasoning_effort as string | undefined]];
    for (const [m, e] of fallbacks) if (m !== primary) attempts.push([m, e]);
    let res: Response | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const [model, effort] = attempts[i];
      const b: Record<string, unknown> = { ...body, model };
      if (i > 0) {
        delete b.reasoning_effort;
        const e = effort ?? (body.reasoning_effort as string | undefined);
        if (e != null) b.reasoning_effort = e;
      }
      res = await inner(input, { ...init, body: JSON.stringify(b) });
      if (res.status !== 429 || i === attempts.length - 1) {
        if (i > 0) console.info(`LLM fallback: answered by ${model} (after ${i} rate-limited model(s))`);
        return res;
      }
      await res.body?.cancel();
      console.info(`LLM ${model} is rate-limited; trying ${attempts[i + 1][0]}`);
    }
    return res!;
  };
}

let client: OpenAI | null = null;

export function llm(): OpenAI {
  if (client) return client;
  const s = settings();
  client = new OpenAI({
    baseURL: s.llmBaseUrl,
    apiKey: s.llmApiKey || "unused",
    maxRetries: 1,
    timeout: 60_000,
    fetch: fallbackFetch(parseFallbacks(s.llmFallbackModels)),
  });
  return client;
}
