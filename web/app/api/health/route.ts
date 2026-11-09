import { connection } from "next/server";

import { settings } from "@/lib/agent/config";
import { db } from "@/lib/agent/db";

// GET /api/health → the boot screen's checklist. Same shape as the Python agent's /api/health.
// The model check (list models) is cached for 5 minutes so the boot screen's polling doesn't spend quota.

type Status = "ready" | "error";
interface Component {
  key: string;
  label: string;
  provider: string;
  model: string;
  status: Status;
  detail: string;
  error: string | null;
  fix: string | null;
  duration_ms: number | null;
  local: boolean;
}

let llmCheck: { at: number; ok: boolean; detail: string; error: string | null } | null = null;

async function checkLlm(base: string, key: string, model: string) {
  if (llmCheck && Date.now() - llmCheck.at < 5 * 60_000) return llmCheck;
  try {
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
    llmCheck = { at: Date.now(), ok: ids.includes(model), detail: ids.includes(model) ? "reachable" : "", error: ids.includes(model) ? null : `Model '${model}' not offered by the provider` };
  } catch (e) {
    llmCheck = { at: Date.now(), ok: false, detail: "", error: `Provider not reachable: ${(e as Error).message}` };
  }
  return llmCheck;
}

export async function GET() {
  await connection();
  const s = settings();
  const t0 = performance.now();
  const comp = (c: Omit<Component, "local" | "duration_ms"> & { duration_ms?: number | null }): Component => ({ local: false, duration_ms: null, ...c });

  const [dbRes, kbRes, llm] = await Promise.all([
    db().from("dentists").select("id", { count: "exact", head: true }).then((r) => r, (e: Error) => ({ error: e, count: null })),
    db().from("kb_documents").select("id", { count: "exact", head: true }).then((r) => r, (e: Error) => ({ error: e, count: null })),
    s.llmApiKey ? checkLlm(s.llmBaseUrl, s.llmApiKey, s.llmModel) : Promise.resolve({ ok: false, detail: "", error: "LLM_API_KEY is not set" }),
  ]);
  const dbOk = !dbRes.error;
  const components: Record<string, Component> = {
    database: comp({
      key: "database", label: "Database", provider: "supabase", model: "postgres",
      status: dbOk ? "ready" : "error", detail: dbOk ? `${dbRes.count} dentists` : "",
      error: dbOk ? null : String(dbRes.error?.message ?? dbRes.error), fix: dbOk ? null : "Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      duration_ms: Math.round(performance.now() - t0),
    }),
    llm: comp({
      key: "llm", label: "Language model", provider: new URL(s.llmBaseUrl).hostname.replace(/^api\./, ""), model: s.llmModel,
      status: llm.ok ? "ready" : "error", detail: llm.ok ? `${llm.detail}${s.llmFallbackModels ? ", with fallbacks" : ""}` : "",
      error: llm.error, fix: llm.ok ? null : "Check LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.",
    }),
    embeddings: comp({
      key: "embeddings", label: "FAQ search", provider: "postgres", model: "full-text search",
      status: "ready", detail: "no model needed", error: null, fix: null,
    }),
    knowledge_base: comp({
      key: "knowledge_base", label: "Knowledge base", provider: "postgres", model: "kb_documents",
      status: kbRes.error ? "error" : (kbRes.count ?? 0) > 0 ? "ready" : "error",
      detail: `${kbRes.count ?? 0} documents`, error: kbRes.error ? String(kbRes.error.message ?? kbRes.error) : null,
      fix: kbRes.error || !kbRes.count ? "Run the migrations and seed (supabase db push --include-seed)." : null,
    }),
    stt: comp({
      key: "stt", label: "Speech recognition", provider: "groq", model: s.sttModel,
      status: s.sttApiKey ? "ready" : "error", detail: s.sttApiKey ? "per utterance, from the browser" : "",
      error: s.sttApiKey ? null : "STT_API_KEY is not set", fix: s.sttApiKey ? null : "Set STT_API_KEY (a Groq key).",
    }),
    tts: comp({
      key: "tts", label: "Voice", provider: "browser", model: "Kokoro-82M (in your browser)",
      status: "ready", detail: "loads on the first call", error: null, fix: null,
    }),
  };
  const statuses = Object.values(components).map((c) => c.status);
  const ready = statuses.filter((x) => x === "ready").length;
  return Response.json({
    status: statuses.includes("error") ? "degraded" : "ok",
    running_on: `${s.llmModel} · Groq Whisper · Kokoro (browser)`,
    all_local: false,
    demo_mode: s.demoMode,
    prompt_version: s.promptVersion,
    voice_transport: "browser",
    backend: "serverless",
    warmup: { ready, total: statuses.length, started_at: null, finished_at: null, elapsed_s: 0 },
    components,
  });
}
