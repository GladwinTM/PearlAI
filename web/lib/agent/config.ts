import "server-only";

import { existsSync } from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

// One .env at the repo root serves the Python agent and this app. Next only reads env files inside web/, and its
// route handlers don't see variables loaded in next.config, so load the root file here (once). Variables already
// set (shell, Vercel project settings) always win. On Vercel there is no root .env: this is a no-op.
let rootEnvLoaded = false;
function loadRootEnv() {
  if (rootEnvLoaded) return;
  rootEnvLoaded = true;
  const root = path.resolve(process.cwd(), "..");
  if (existsSync(path.join(root, ".env"))) loadEnvConfig(root, process.env.NODE_ENV !== "production", { info: () => {}, error: console.error });
}

// Settings for the serverless agent (Next.js route handlers). Same variable names as the Python agent, so one .env
// serves both. Defaults mirror agent/hosted.env (free hosted providers); a test keeps them in sync.
export const HOSTED_DEFAULTS = {
  LLM_BASE_URL: "https://api.groq.com/openai/v1",
  LLM_MODEL: "openai/gpt-oss-20b",
  LLM_DISABLE_THINKING: "true",
  LLM_REASONING_EFFORT: "low",
  LLM_FALLBACK_MODELS: "openai/gpt-oss-120b,qwen/qwen3.8-27b:none",
  STT_MODEL: "whisper-large-v3-turbo",
  DEMO_MODE: "true",
  MAX_VOICE_CALLS_PER_DAY: "60",
  RATE_LIMIT_PER_MINUTE: "30",
} as const;

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

const bool = (v: string) => ["1", "true", "yes", "on"].includes(v.toLowerCase());

export interface Settings {
  supabaseUrl: string;
  supabaseKey: string;
  clinicTimezone: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmTemperature: number;
  llmReasoningEffort: string | null; // null = don't send (LLM_DISABLE_THINKING=false)
  llmFallbackModels: string;
  sttBaseUrl: string;
  sttApiKey: string;
  sttModel: string;
  promptVersion: string;
  demoMode: boolean;
  maxVoiceCallsPerDay: number;
  rateLimitPerMinute: number;
}

export function settings(): Settings {
  loadRootEnv();
  const groqKey = env("STT_API_KEY");
  return {
    supabaseUrl: env("SUPABASE_URL", "http://127.0.0.1:54321"),
    supabaseKey: env("SUPABASE_SERVICE_ROLE_KEY"),
    clinicTimezone: env("CLINIC_TIMEZONE", "Asia/Kolkata"),
    llmBaseUrl: env("LLM_BASE_URL", HOSTED_DEFAULTS.LLM_BASE_URL).replace(/\/$/, ""),
    llmApiKey: env("LLM_API_KEY", groqKey),
    llmModel: env("LLM_MODEL", HOSTED_DEFAULTS.LLM_MODEL),
    llmTemperature: Number(env("LLM_TEMPERATURE", "0.3")),
    llmReasoningEffort: bool(env("LLM_DISABLE_THINKING", HOSTED_DEFAULTS.LLM_DISABLE_THINKING))
      ? env("LLM_REASONING_EFFORT", HOSTED_DEFAULTS.LLM_REASONING_EFFORT)
      : null,
    llmFallbackModels: env("LLM_FALLBACK_MODELS", HOSTED_DEFAULTS.LLM_FALLBACK_MODELS),
    sttBaseUrl: env("STT_BASE_URL", "https://api.groq.com/openai/v1").replace(/\/$/, ""),
    sttApiKey: groqKey,
    sttModel: env("STT_MODEL", HOSTED_DEFAULTS.STT_MODEL),
    promptVersion: env("PROMPT_VERSION", "v2"),
    demoMode: bool(env("DEMO_MODE", HOSTED_DEFAULTS.DEMO_MODE)),
    maxVoiceCallsPerDay: Number(env("MAX_VOICE_CALLS_PER_DAY", HOSTED_DEFAULTS.MAX_VOICE_CALLS_PER_DAY)),
    rateLimitPerMinute: Number(env("RATE_LIMIT_PER_MINUTE", HOSTED_DEFAULTS.RATE_LIMIT_PER_MINUTE)),
  };
}
