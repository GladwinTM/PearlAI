"use client";

import { Cpu, Database, HardDrive, ShieldCheck } from "lucide-react";

import { useHealth } from "@/components/boot/health-provider";
import { Skeleton } from "@/components/ui/skeleton";
import { BACKEND } from "@/lib/config";

const PILL = ["bg-yellow", "bg-lime", "bg-pink", "bg-lavender", "bg-sky"];

/** The providers actually in use, read from /api/health. */
export function LocalBadges() {
  const { health } = useHealth();
  const comps = health ? ["llm", "stt", "tts", "embeddings", "database"].map((k) => health.components[k]).filter(Boolean) : [];
  const local = BACKEND === "python" && (!health || health.all_local);
  return (
    <section aria-labelledby="local-title" className="mx-auto w-full max-w-6xl px-4 py-16 sm:py-24">
      <div className="brick rounded-[2rem] bg-card p-6 sm:p-10">
        <div className="flex flex-wrap items-center gap-3">
          <span className="brick grid size-12 place-items-center rounded-2xl bg-lime text-deep [--brick-depth:3px]">
            <ShieldCheck className="size-6" aria-hidden />
          </span>
          <h2 id="local-title" className="font-display text-3xl leading-none font-bold uppercase sm:text-5xl">
            {local ? "Runs 100% locally" : "Free tiers, swappable"}
          </h2>
        </div>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          {local
            ? "No paid APIs and no cloud calls by default. Every model can be swapped for a hosted one with a single env setting."
            : "Groq's free tier for the model and speech-to-text, Supabase for the data, and Pearl's voice in your browser. Every provider is swappable with one environment variable."}
        </p>
        <ul className="mt-6 flex flex-wrap gap-3" aria-label="Providers in use">
          {!health &&
            Array.from({ length: 5 }, (_, i) => (
              <li key={i}>
                <Skeleton className="h-9 w-40 rounded-full" />
              </li>
            ))}
          {comps.map((c, i) => {
            const Icon = c.key === "database" ? Database : c.key === "llm" ? Cpu : HardDrive;
            return (
              <li key={c.key} className={`brick inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium text-deep [--brick-depth:3px] ${PILL[i % PILL.length]}`}>
                <Icon className="size-4" aria-hidden />
                <span className="font-semibold">{c.label}:</span> {c.model}
                {c.local && <span className="sr-only"> (local)</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
