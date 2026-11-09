"use client";

import { Check, CircleAlert, Loader2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

import { ToothMark } from "@/components/pearl/tooth-mark";
import { Button } from "@/components/ui/button";
import type { HealthComponent } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useHealth } from "./health-provider";

const ORDER = ["database", "llm", "embeddings", "knowledge_base", "stt", "tts"];
const SEEN_KEY = "smiledesk.booted";
const noop = () => () => {};

function seenThisSession() {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The boot screen: an honest, staged checklist of the real warmup (it polls /api/health, nothing is faked).
 * Shown on first load, and again whenever the agent reports it is warming up or unreachable.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const { health, unreachable } = useHealth();
  const reduce = useReducedMotion();
  const [dismissed, setDismissed] = useState(false);
  const [settled, setSettled] = useState(false);

  const ready = health?.status === "ok";
  // Once everything is ready, keep the checklist up briefly so the last ticks are visible (skipped on later pages).
  useEffect(() => {
    if (!ready) return;
    const quick = seenThisSession() || reduce;
    const t = setTimeout(() => setSettled(true), quick ? 0 : 650);
    try {
      window.sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
    return () => clearTimeout(t);
  }, [ready, reduce]);

  // Booted earlier in this tab: navigating between pages shouldn't flash the overlay (false during hydration).
  const seen = useSyncExternalStore(noop, seenThisSession, () => false);
  // Shown again whenever the agent goes back to warming up or becomes unreachable.
  const show = !dismissed && (unreachable || !health || !ready || !(settled || seen));
  const degraded = health?.status === "degraded";

  return (
    <>
      {children}
      <AnimatePresence>
        {show && (
          <motion.div
            key="boot"
            role="dialog"
            aria-modal="true"
            aria-labelledby="boot-title"
            className="on-sky studs fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-sky px-4 py-8 text-deep"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.35 } }}
          >
            <div className="w-full max-w-md">
              <div className="mb-6 flex flex-col items-center text-center">
                <BrushingTooth sad={unreachable || degraded} />
                <h1 id="boot-title" className="mt-4 font-display text-3xl leading-none font-bold uppercase">
                  {unreachable ? "Can't reach Pearl's server" : degraded ? "Some services need attention" : "Waking Pearl up"}
                </h1>
                <p className="mt-2 text-sm font-medium" aria-live="polite">
                  {unreachable
                    ? "The agent API isn't responding."
                    : health
                      ? `${health.warmup.ready} of ${health.warmup.total} ready${health.warmup.elapsed_s != null ? ` · ${health.warmup.elapsed_s}s` : ""}.${health.all_local ? " Everything runs on this machine." : ""}`
                      : "Checking services…"}
                </p>
              </div>

              {unreachable ? (
                <div role="alert" className="brick rounded-[1.5rem] bg-card p-4 text-sm text-foreground">
                  <p>
                    Start it with <code className="rounded bg-muted px-1.5 py-0.5 font-mono">make agent</code> (or{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono">make dev</code> for everything). This page retries on its own.
                  </p>
                </div>
              ) : (
                <ul className="brick divide-y-2 divide-edge-soft overflow-hidden rounded-[1.5rem] bg-card text-foreground" aria-label="Service warmup">
                  {ORDER.map((k) => health?.components[k])
                    .filter((c): c is HealthComponent => Boolean(c))
                    .map((c, i) => (
                      <BootRow key={c.key} c={c} index={i} />
                    ))}
                  {!health &&
                    ORDER.map((k) => (
                      <li key={k} className="flex h-14 items-center gap-3 px-4">
                        <span className="size-5 animate-pulse rounded-full bg-muted" />
                        <span className="h-3 w-40 animate-pulse rounded bg-muted" />
                      </li>
                    ))}
                </ul>
              )}

              {(degraded || unreachable) && (
                <div className="mt-4 flex justify-center">
                  <Button variant="outline" onClick={() => setDismissed(true)}>
                    Continue anyway
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function BootRow({ c, index }: { c: HealthComponent; index: number }) {
  const reduce = useReducedMotion();
  const state = c.status;
  return (
    <motion.li
      className="flex items-start gap-3 px-4 py-3"
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06 }}
    >
      <span
        className={cn(
          "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
          state === "ready" && "bg-success/15 text-success",
          state === "error" && "bg-destructive/15 text-destructive",
          (state === "loading" || state === "pending") && "text-muted-foreground",
        )}
        aria-hidden
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={state}
            initial={reduce ? false : { scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 28 }}
          >
            {state === "ready" ? (
              <Check className="size-3.5" strokeWidth={3} />
            ) : state === "error" ? (
              <CircleAlert className="size-4" />
            ) : (
              <Loader2 className={cn("size-4", state === "loading" && "animate-spin")} />
            )}
          </motion.span>
        </AnimatePresence>
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">
          {c.label} <span className="font-normal text-muted-foreground">({c.model})</span>
        </p>
        <p className={cn("text-muted-foreground", state === "error" && "text-destructive")}>
          {state === "error" ? (c.fix ?? c.error) : state === "ready" ? c.detail : state === "loading" ? "Loading…" : "Waiting…"}
        </p>
      </div>
      <span className="sr-only">{state}</span>
      {state === "ready" && c.duration_ms != null && (
        <span className="text-xs tabular-nums text-muted-foreground">{(c.duration_ms / 1000).toFixed(1)}s</span>
      )}
    </motion.li>
  );
}

/** Pearl brushing her teeth while the services warm up (a worried face if something is wrong). */
function BrushingTooth({ sad }: { sad: boolean }) {
  return (
    <div className="relative h-28 w-28" aria-hidden>
      <motion.div animate={sad ? { rotate: [0, -3, 3, 0] } : { y: [0, -3, 0] }} transition={{ duration: sad ? 0.5 : 0.9, repeat: Infinity, ease: "easeInOut" }}>
        <ToothMark face={sad ? "worried" : "sleepy"} className="h-28 w-auto drop-shadow-[0_5px_0_var(--edge)]" />
      </motion.div>
      {!sad && (
        <>
          <motion.svg
            viewBox="0 0 120 34"
            className="absolute top-[52%] -right-9 h-6 w-20"
            animate={{ x: [0, -14, 0], rotate: [-8, -2, -8] }}
            transition={{ duration: 0.45, repeat: Infinity, ease: "easeInOut" }}
          >
            <rect x="34" y="16" width="84" height="12" rx="6" fill="var(--coral)" stroke="var(--edge)" strokeWidth="2.5" />
            <rect x="2" y="18" width="36" height="9" rx="4.5" fill="var(--card)" stroke="var(--edge)" strokeWidth="2.5" />
            {[6, 13, 20, 27].map((x) => (
              <rect key={x} x={x} y="3" width="5" height="15" rx="2.5" fill="var(--card)" stroke="var(--edge)" strokeWidth="1.8" />
            ))}
          </motion.svg>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="absolute size-3 rounded-full border-2 border-edge bg-card"
              style={{ left: `${30 + i * 18}%`, top: "58%" }}
              animate={{ y: [0, -40], opacity: [0, 1, 0], scale: [0.4, 1, 0.8] }}
              transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.45, ease: "easeOut" }}
            />
          ))}
        </>
      )}
    </div>
  );
}
