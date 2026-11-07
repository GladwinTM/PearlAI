"use client";

import { Check } from "lucide-react";

import { PERSONAS } from "@/lib/personas";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}

/** "Who are you?" for recruiters: each persona carries a caller ID, so nobody types phone numbers. */
export function PersonaSwitcher({ value, onChange, disabled, compact, className }: Props) {
  return (
    <fieldset className={cn("min-w-0", className)} disabled={disabled}>
      <legend className={cn("mb-2 text-sm font-medium", compact && "sr-only")}>Who are you calling as?</legend>
      <div role="radiogroup" aria-label="Persona" className={cn(compact ? "-mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5 [scrollbar-width:none]" : "grid grid-cols-1 gap-2 min-[420px]:grid-cols-2")}>
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
              onKeyDown={(e) => {
                const i = PERSONAS.findIndex((x) => x.id === value);
                const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = PERSONAS[(i + step + PERSONAS.length) % PERSONAS.length];
                onChange(next.id);
                (e.currentTarget.parentElement?.querySelector(`[data-testid="persona-${next.id}"]`) as HTMLElement | null)?.focus();
              }}
              tabIndex={active ? 0 : -1}
              className={cn(
                "group relative flex shrink-0 items-center gap-2 rounded-xl border bg-card px-3 text-left transition-colors disabled:opacity-60",
                compact ? cn("rounded-full py-1 pr-3", active ? "pl-1" : "pl-3") : "py-2.5",
                active ? "border-primary/70 bg-accent ring-1 ring-primary/40" : "hover:bg-accent/60",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold",
                  compact && !active && "hidden",
                  active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                  compact && "size-6 text-[0.65rem]",
                )}
              >
                {active ? <Check className="size-3.5" strokeWidth={3} /> : p.initials}
              </span>
              <span className="min-w-0">
                <span className={cn("block text-sm font-medium", !compact && "truncate")}>{p.label}</span>
                {!compact && <span className="block truncate text-xs text-muted-foreground">{p.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
