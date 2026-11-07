import { AGENT_URL } from "./config";

export type ComponentStatus = "pending" | "loading" | "ready" | "error";

export interface HealthComponent {
  key: string;
  label: string;
  provider: string;
  model: string;
  status: ComponentStatus;
  detail: string;
  error: string | null;
  fix: string | null;
  duration_ms: number | null;
  local: boolean;
}

export interface Health {
  status: "ok" | "warming" | "degraded";
  running_on: string;
  all_local: boolean;
  demo_mode: boolean;
  prompt_version: string;
  voice_transport: string;
  warmup: { ready: number; total: number; elapsed_s: number | null };
  components: Record<string, HealthComponent>;
}

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch(`${AGENT_URL}/api/health`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  return (await res.json()) as Health;
}
