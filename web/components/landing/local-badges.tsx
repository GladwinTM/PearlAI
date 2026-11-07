"use client";

import { Cpu, Database, HardDrive, ShieldCheck } from "lucide-react";

import { useHealth } from "@/components/boot/health-provider";
import { Skeleton } from "@/components/ui/skeleton";

/** "Runs 100% locally": read from /api/health, so it shows the providers actually in use. */
export function LocalBadges() {
  const { health } = useHealth();
  const comps = health ? ["llm", "stt", "tts", "embeddings", "database"].map((k) => health.components[k]).filter(Boolean) : [];
  return (
    <section aria-labelledby="local-title" className="mx-auto w-full max-w-6xl px-4 pb-16">
      <div className="rounded-3xl border bg-card p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <ShieldCheck className="size-6 text-primary" aria-hidden />
          <h2 id="local-title" className="text-xl font-semibold tracking-tight">
            {health && !health.all_local ? "Running on swappable providers" : "Runs 100% locally"}
          </h2>
        </div>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          No paid APIs and no cloud calls by default. Every model can be swapped for a hosted one with a single env setting.
        </p>
        <ul className="mt-5 flex flex-wrap gap-2" aria-label="Providers in use">
          {!health &&
            Array.from({ length: 5 }, (_, i) => (
              <li key={i}>
                <Skeleton className="h-8 w-36 rounded-full" />
              </li>
            ))}
          {comps.map((c) => {
            const Icon = c.key === "database" ? Database : c.key === "llm" ? Cpu : HardDrive;
            return (
              <li key={c.key} className="inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-sm">
                <Icon className="size-3.5 text-primary" aria-hidden />
                <span className="text-muted-foreground">{c.label}</span> {c.model}
                {c.local && <span className="sr-only"> (local)</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
