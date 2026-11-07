"use client";

import { Check, CircleAlert, Loader2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

import { PearlMark } from "@/components/brand/logo";
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
            className="fixed inset-0 z-50 grid place-items-center bg-background/95 px-4 backdrop-blur-sm bg-pearl-glow"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.35 } }}
          >
            <div className="w-full max-w-md">
              <div className="mb-6 flex flex-col items-center text-center">
                <motion.div
                  animate={{ scale: [1, 1.06, 1] }}
                  transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                >
                  <PearlMark className="size-16 drop-shadow-[0_8px_24px_rgba(42,157,143,0.35)]" />
                </motion.div>
                <h1 id="boot-title" className="mt-4 text-xl font-semibold tracking-tight">
                  {unreachable ? "Can't reach Pearl's server" : degraded ? "Some services need attention" : "Waking Pearl up"}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
                  {unreachable
                    ? "The agent API isn't responding."
                    : health
                      ? `${health.warmup.ready} of ${health.warmup.total} ready${health.warmup.elapsed_s != null ? ` · ${health.warmup.elapsed_s}s` : ""}. Everything runs on this machine.`
                      : "Checking services…"}
                </p>
              </div>

              {unreachable ? (
                <div role="alert" className="rounded-xl border bg-card p-4 text-sm">
                  <p>
                    Start it with <code className="rounded bg-muted px-1.5 py-0.5 font-mono">make agent</code> (or{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono">make dev</code> for everything). This page retries on its own.
                  </p>
                </div>
              ) : (
                <ul className="divide-y rounded-xl border bg-card" aria-label="Service warmup">
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
