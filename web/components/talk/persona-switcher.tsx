"use client";

import { Check } from "lucide-react";
import { motion } from "motion/react";
import type { KeyboardEvent } from "react";

import { ToothMark, type ToothFace } from "@/components/pearl/tooth-mark";
import { PERSONAS } from "@/lib/personas";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** One row of small chips (talk page). */
  compact?: boolean;
  /** Tall colourful cards with a tooth each (landing page). */
  cards?: boolean;
  className?: string;
}

// Card colour and tooth per persona. Navy text on all of these fills is ≥ 6:1.
const LOOK: Record<string, { bg: string; face: ToothFace; baby?: boolean }> = {
  ravi: { bg: "bg-yellow", face: "smile" },
  anjali: { bg: "bg-coral", face: "open" },
  ravi_meena: { bg: "bg-lime", face: "smile", baby: true },
  new: { bg: "bg-lavender", face: "confused" },
};

/** "Who are you?" for recruiters: each persona carries a caller ID, so nobody types phone numbers. */
export function PersonaSwitcher({ value, onChange, disabled, compact, cards, className }: Props) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = PERSONAS.findIndex((x) => x.id === value);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = PERSONAS[(i + step + PERSONAS.length) % PERSONAS.length];
    onChange(next.id);
    (e.currentTarget.closest('[role="radiogroup"]')?.querySelector(`[data-testid="persona-${next.id}"]`) as HTMLElement | null)?.focus();
  };

  if (cards) {
    return (
      <fieldset className={cn("min-w-0", className)} disabled={disabled}>
        <legend className="sr-only">Who are you calling as?</legend>
        <div role="radiogroup" aria-label="Persona" className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
          {PERSONAS.map((p) => {
            const active = p.id === value;
            const look = LOOK[p.id] ?? LOOK.new;
            return (
              <motion.button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`persona-${p.id}`}
                onClick={() => onChange(p.id)}
                onKeyDown={onKeyDown}
                tabIndex={active ? 0 : -1}
                // The picked card hops.
                animate={active ? { y: [0, -18, 0] } : { y: 0 }}
                transition={{ duration: 0.38, ease: "easeOut" }}
                className={cn(
                  "brick press group relative flex min-h-56 flex-col overflow-hidden rounded-[2rem] p-4 text-left text-deep sm:min-h-72 sm:p-5",
                  look.bg,
                  active && "outline-4 outline-offset-4 outline-primary",
                )}
              >
                <span className="font-display text-2xl leading-[0.95] font-bold uppercase sm:text-3xl">{p.label}</span>
                <span className="mt-1 text-sm font-medium">{p.description}</span>
                <span
                  aria-hidden
                  className={cn(
                    "brick absolute top-4 right-4 grid size-8 place-items-center rounded-full bg-card transition-transform [--brick-depth:2px]",
                    active ? "scale-100" : "scale-0",
                  )}
                >
                  <Check className="size-4 text-foreground" strokeWidth={3} />
                </span>
                <span aria-hidden className="mt-auto flex items-end justify-center pt-3">
                  <ToothMark face={look.face} className="h-24 w-auto transition-transform group-hover:-rotate-6 sm:h-32" />
                  {look.baby && <ToothMark face="open" className="-ml-3 h-12 w-auto sm:h-16" />}
                </span>
              </motion.button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  return (
    <fieldset className={cn("min-w-0", className)} disabled={disabled}>
      <legend className={cn("mb-2 text-sm font-semibold", compact && "sr-only")}>Who are you calling as?</legend>
      <div
        role="radiogroup"
        aria-label="Persona"
        className={cn(compact ? "-mx-1 flex gap-1.5 overflow-x-auto px-1 pt-0.5 pb-1.5 [scrollbar-width:none]" : "grid grid-cols-1 gap-2 min-[420px]:grid-cols-2")}
      >
        {PERSONAS.map((p) => {
          const active = p.id === value;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`persona-${p.id}`}
              onClick={() => onChange(p.id)}
              onKeyDown={onKeyDown}
              tabIndex={active ? 0 : -1}
              className={cn(
                "group relative flex shrink-0 items-center gap-2 rounded-full px-3 text-left transition-colors disabled:opacity-60",
                compact ? cn("py-1 pr-3", active ? "pl-1" : "pl-3") : "py-2.5",
                active ? "brick bg-yellow text-deep [--brick-depth:2px]" : "border-2 border-edge-soft bg-card hover:bg-accent",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold",
                  compact && !active && "hidden",
                  active ? "bg-card text-foreground" : "bg-muted text-muted-foreground",
                  compact && "size-6 text-[0.65rem]",
                )}
              >
                {active ? <Check className="size-3.5" strokeWidth={3} /> : p.initials}
              </span>
              <span className="min-w-0">
                <span className={cn("block text-sm font-semibold", !compact && "truncate")}>{p.label}</span>
                {!compact && <span className="block truncate text-xs opacity-80">{p.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
