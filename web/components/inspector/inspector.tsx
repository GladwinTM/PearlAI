"use client";

import {
  Ban,
  Bot,
  CircleCheck,
  Hand,
  Info,
  MessageSquare,
  Package,
  ShieldAlert,
  TriangleAlert,
  Undo2,
  Wrench,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

import { useHealth } from "@/components/boot/health-provider";
import { Badge } from "@/components/ui/badge";
import type { LatencySegment, TimelineItem, TimelineKind, TurnLatency } from "@/lib/talk";
import { cn } from "@/lib/utils";

const KIND: Record<TimelineKind, { icon: typeof Info; tone: string; label: string }> = {
  user: { icon: MessageSquare, tone: "text-foreground", label: "Caller" },
  pearl: { icon: Bot, tone: "text-primary", label: "Pearl" },
  tool_call: { icon: Wrench, tone: "text-chart-2", label: "Tool call" },
  tool_result: { icon: Package, tone: "text-chart-2", label: "Tool result" },
  safety: { icon: ShieldAlert, tone: "text-destructive", label: "Safety" },
  retract: { icon: Undo2, tone: "text-warning", label: "Guard" },
  blocked: { icon: Ban, tone: "text-warning", label: "Guard" },
  interrupt: { icon: Hand, tone: "text-muted-foreground", label: "Barge-in" },
  outcome: { icon: CircleCheck, tone: "text-success", label: "Outcome" },
  error: { icon: TriangleAlert, tone: "text-destructive", label: "Error" },
  info: { icon: Info, tone: "text-muted-foreground", label: "Info" },
};

const SEG_COLOR: Record<LatencySegment["key"], string> = {
  stt: "bg-chart-2",
  llm: "bg-chart-1",
  tts: "bg-chart-3",
  tools: "bg-chart-4",
  rest: "bg-muted-foreground/30",
};

function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

export function Inspector({ timeline, latencies, className }: { timeline: TimelineItem[]; latencies: TurnLatency[]; className?: string }) {
  return (
    <div className={cn("flex min-h-0 flex-col gap-4", className)}>
      <RunningOn />
      <LatencyPanel latencies={latencies} />
      <Timeline items={timeline} />
    </div>
  );
}

function RunningOn() {
  const { health } = useHealth();
  if (!health) return <div className="h-12 animate-pulse rounded-[1.25rem] bg-muted" />;
  const comps = ["llm", "stt", "tts", "embeddings"].map((k) => health.components[k]).filter(Boolean);
  return (
    <section aria-label="Running on" className="brick-soft rounded-[1.25rem] bg-card p-3 [--brick-depth:3px]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Running on</h3>
        {health.all_local && (
          <Badge variant="secondary" className="bg-success/15 text-success">
            100% local
          </Badge>
        )}
      </div>
      <ul className="flex flex-wrap gap-1.5 text-xs">
        {comps.map((c) => (
          <li key={c.key} className="rounded-full bg-muted px-2.5 py-1" title={`${c.label}: ${c.provider}`}>
            <span className="text-muted-foreground">{c.label}:</span> {c.model}
          </li>
        ))}
        <li className="rounded-full bg-muted px-2.5 py-1">
          <span className="text-muted-foreground">Prompt:</span> {health.prompt_version}
        </li>
      </ul>
    </section>
  );
}

function LatencyPanel({ latencies }: { latencies: TurnLatency[] }) {
  const reduce = useReducedMotion();
  const shown = latencies.slice(-6);
  const max = Math.max(2000, ...shown.map((l) => l.total ?? 0));
  const voice = latencies.filter((l) => l.channel === "voice" && !l.partial && !l.tools && l.total != null).map((l) => l.total as number);
  const med = median(voice);
  return (
    <section aria-label="Latency per turn" className="brick-soft rounded-[1.25rem] bg-card p-3 [--brick-depth:3px]">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Latency per turn</h3>
        {med != null && (
          <span className="text-xs text-muted-foreground">
            median voice-to-voice <strong className="text-foreground tabular-nums">{secs(med)}</strong>
          </span>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Each reply gets a bar: speech-to-text, LLM first token, TTS first byte.</p>
      ) : (
        <ol className="space-y-2">
          {shown.map((l, i) => {
            const label = l.segments.map((s) => `${s.label} ${s.ms} ms`).join(", ");
            return (
              <li key={l.id} className="text-xs">
                <div className="mb-1 flex justify-between gap-2 text-muted-foreground">
                  <span>
                    #{latencies.length - shown.length + i + 1} · {l.channel}
                    {l.tools ? ` · ${l.tools} tool${l.tools > 1 ? "s" : ""}` : ""}
                    {l.partial ? " · cut off" : ""}
                  </span>
                  <span className="tabular-nums text-foreground">
                    {l.total != null ? secs(l.total) : "—"} <span className="text-muted-foreground">{l.totalLabel}</span>
                    {l.answerMs != null && l.tools > 0 ? <span className="text-muted-foreground"> · answer {secs(l.answerMs)}</span> : null}
                  </span>
                </div>
                <div className="flex h-3 overflow-hidden rounded-full bg-muted ring-1 ring-edge-soft" role="img" aria-label={label || "no breakdown"}>
                  {l.segments.map((s) => (
                    <motion.span
                      key={s.key}
                      className={cn("h-full", SEG_COLOR[s.key])}
                      initial={reduce ? false : { width: 0 }}
                      animate={{ width: `${(s.ms / max) * 100}%` }}
                      transition={{ duration: 0.5, ease: "easeOut" }}
                      title={`${s.label}: ${s.ms} ms`}
                    />
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[0.7rem] text-muted-foreground" aria-label="Legend">
        {(["stt", "llm", "tts", "tools"] as const).map((k) => (
          <li key={k} className="flex items-center gap-1">
            <span className={cn("size-2 rounded-full", SEG_COLOR[k])} aria-hidden />
            {{ stt: "STT", llm: "LLM 1st token", tts: "TTS 1st byte", tools: "tools" }[k]}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Timeline({ items }: { items: TimelineItem[] }) {
  const reduce = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [items.length, reduce]);

  return (
    <section aria-label="Event timeline" className="brick-soft flex min-h-0 flex-1 flex-col rounded-[1.25rem] bg-card [--brick-depth:3px]">
      <h3 className="border-b-2 border-edge-soft px-3 py-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Timeline</h3>
      <div
        ref={box}
        tabIndex={0}
        aria-label="Timeline events"
        className="min-h-40 flex-1 overflow-y-auto p-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">
            Tool calls, results, guards and safety rules will appear here as Pearl works.
          </p>
        ) : (
          <ol className="space-y-1" data-testid="timeline">
            <AnimatePresence initial={false}>
              {items.map((it) => (
                <TimelineRow key={it.id} it={it} />
              ))}
            </AnimatePresence>
          </ol>
        )}
      </div>
    </section>
  );
}

function TimelineRow({ it }: { it: TimelineItem }) {
  const reduce = useReducedMotion();
  const k = KIND[it.kind];
  const Icon = k.icon;
  return (
    <motion.li
      data-kind={it.kind}
      initial={reduce ? false : { opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2 }}
      className={cn("rounded-xl px-2 py-1.5 text-xs", it.kind === "outcome" && "bg-lime/30", it.kind === "safety" && "bg-coral/25")}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", k.tone)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cn("break-words", it.kind.startsWith("tool") && "font-mono")}>
            <span className="sr-only">{k.label}: </span>
            {it.title}
          </p>
          {it.detail && <p className="text-muted-foreground">{it.detail}</p>}
          {it.json !== undefined && it.kind === "tool_result" && (
            <details className="mt-1">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">JSON</summary>
              <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-muted p-2 font-mono text-[0.7rem] leading-snug">
                {JSON.stringify(it.json, null, 2)}
              </pre>
            </details>
          )}
        </div>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {it.ms != null ? `${it.ms} ms` : `${(it.at / 1000).toFixed(1)}s`}
        </span>
      </div>
    </motion.li>
  );
}
