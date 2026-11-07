"use client";

import { useEffect, useState } from "react";

import { getHealth, type Health } from "@/lib/api";

const ORDER = ["database", "llm", "stt", "tts", "embeddings", "knowledge_base"];

const ICON: Record<string, string> = { ready: "✓", error: "✕", loading: "…", pending: "·" };

/** Minimal M1 status view. Polls /api/health until every component is ready. M4 replaces this with the boot screen. */
export function HealthPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const ctrl = new AbortController();

    const tick = async () => {
      try {
        const h = await getHealth(ctrl.signal);
        if (stopped) return;
        setHealth(h);
        setUnreachable(false);
        timer = setTimeout(tick, h.status === "warming" ? 1000 : 5000);
      } catch {
        if (stopped) return;
        setUnreachable(true);
        timer = setTimeout(tick, 2000);
      }
    };
    tick();
    return () => {
      stopped = true;
      ctrl.abort();
      clearTimeout(timer);
    };
  }, []);

  if (unreachable) {
    return (
      <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
        The agent API isn&apos;t reachable. Start it with <code className="font-mono">make agent</code>.
      </p>
    );
  }
  if (!health) return <p className="text-slate-500" aria-busy="true">Checking services…</p>;

  return (
    <section aria-label="Service status" className="w-full max-w-xl space-y-3">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Running on: <strong>{health.running_on}</strong>
      </p>
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {ORDER.map((key) => health.components[key]).filter(Boolean).map((c) => (
          <li key={c.key} className="flex items-start gap-3 p-3">
            <span
              aria-hidden
              className={
                c.status === "ready"
                  ? "text-teal-700 dark:text-teal-300"
                  : c.status === "error"
                    ? "text-red-700 dark:text-red-300"
                    : "text-slate-500"
              }
            >
              {ICON[c.status]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {c.label} <span className="font-normal text-slate-500">({c.model})</span>
              </p>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {c.status === "error" ? (c.fix ?? c.error) : c.detail || c.status}
                {c.duration_ms != null && c.status === "ready" ? ` · ${c.duration_ms} ms` : ""}
              </p>
            </div>
            <span className="sr-only">{c.status}</span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-slate-500">
        Overall: {health.status} ({health.warmup.ready}/{health.warmup.total} ready)
      </p>
    </section>
  );
}
