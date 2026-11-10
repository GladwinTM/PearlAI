"use client";

import { Cpu, Database, HardDrive, ShieldCheck } from "lucide-react";

import { useHealth } from "@/components/boot/health-provider";
import { Skeleton } from "@/components/ui/skeleton";
import { BACKEND } from "@/lib/config";

/** The providers actually in use, read from /api/health. */
export function LocalBadges() {
  const { health } = useHealth();
  const comps = health ? ["llm", "stt", "tts", "embeddings", "database"].map((k) => health.components[k]).filter(Boolean) : [];
  const local = BACKEND === "python" && (!health || health.all_local);
  return (
    <section aria-labelledby="local-title" className="mx-auto w-full max-w-6xl px-4 py-16 sm:py-20">
      <div className="brick rounded-2xl bg-card p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-success/10 text-success">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <h2 id="local-title" className="text-2xl font-semibold tracking-tight">
            {local ? "Runs 100% locally" : "Free tiers, swappable providers"}
          </h2>
        </div>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          {local
            ? "No paid APIs and no cloud calls by default. Every model can be swapped for a hosted one with a single env setting."
            : "Groq's free tier for the model and speech-to-text, Supabase for the data, and Pearl's voice in your browser. Every provider is swappable with one environment variable."}
        </p>
        <ul className="mt-5 flex flex-wrap gap-2" aria-label="Providers in use">
          {!health &&
            Array.from({ length: 5 }, (_, i) => (
              <li key={i}>
                <Skeleton className="h-8 w-40 rounded-full" />
              </li>
            ))}
          {comps.map((c) => {
            const Icon = c.key === "database" ? Database : c.key === "llm" ? Cpu : HardDrive;
            return (
              <li key={c.key} className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-3 py-1.5 text-sm">
                <Icon className="size-3.5 text-primary" aria-hidden />
                <span className="text-muted-foreground">{c.label}:</span> {c.model}
                {c.local && <span className="sr-only"> (local)</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
