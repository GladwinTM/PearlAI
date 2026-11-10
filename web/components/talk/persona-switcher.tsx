"use client";

import { Check } from "lucide-react";
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
  /** Cards with a tooth avatar (landing page). */
  cards?: boolean;
  className?: string;
}

// A small tooth avatar per persona (a big tooth and a baby tooth for "Ravi for Meena").
const AVATAR: Record<string, { face: ToothFace; baby?: boolean }> = {
  ravi: { face: "smile" },
  anjali: { face: "open" },
  ravi_meena: { face: "smile", baby: true },
  new: { face: "confused" },
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
        <div role="radiogroup" aria-label="Persona" className="grid grid-cols-1 gap-3 min-[460px]:grid-cols-2 lg:grid-cols-4">
          {PERSONAS.map((p) => {
            const active = p.id === value;
            const look = AVATAR[p.id] ?? AVATAR.new;
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
                  "group relative flex items-center gap-4 rounded-2xl border bg-card p-4 text-left shadow-xs transition-all hover:border-primary/40 hover:shadow-sm",
                  active && "border-primary ring-1 ring-primary",
                )}
              >
                <span aria-hidden className="stage flex h-16 w-16 shrink-0 items-end justify-center rounded-xl pb-1.5">
                  <ToothMark face={look.face} className="h-11 w-auto" />
                  {look.baby && <ToothMark face="open" className="-ml-1.5 h-6 w-auto" />}
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold">{p.label}</span>
                  <span className="block text-sm text-muted-foreground">{p.description}</span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-3 right-3 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground transition-transform",
                    active ? "scale-100" : "scale-0",
                  )}
                >
                  <Check className="size-3" strokeWidth={3} />
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  return (
    <fieldset className={cn("min-w-0", className)} disabled={disabled}>
      <legend className={cn("mb-2 text-sm font-medium", compact && "sr-only")}>Who are you calling as?</legend>
      <div
        role="radiogroup"
        aria-label="Persona"
        className={cn(
          compact
            ? "-mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5 [mask-image:linear-gradient(to_right,black_85%,transparent)] [scrollbar-width:none] sm:[mask-image:none]"
            : "grid grid-cols-1 gap-2 min-[420px]:grid-cols-2",
        )}
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
                "flex shrink-0 items-center gap-1.5 rounded-full border px-3 text-left text-sm transition-colors disabled:opacity-60",
                compact ? "py-1" : "py-2",
                active ? "border-primary/40 bg-primary/10 font-medium text-primary" : "bg-card text-foreground hover:bg-muted",
              )}
            >
              {active && <Check className="size-3.5" strokeWidth={3} aria-hidden />}
              <span className="min-w-0">
                <span className={cn("block", !compact && "truncate font-medium")}>{p.label}</span>
                {!compact && <span className="block truncate text-xs text-muted-foreground">{p.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
