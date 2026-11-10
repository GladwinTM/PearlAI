"use client";

import { ArrowUpRight, Sparkles } from "lucide-react";

import { TRY_PROMPTS } from "@/lib/personas";
import { cn } from "@/lib/utils";

interface Props {
  onPick: (prompt: string) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
  /** Larger chips with an arrow (landing page). */
  prominent?: boolean;
}

export function TryChips({ onPick, disabled, label = "Things to try", className, prominent }: Props) {
  return (
    <div className={cn("min-w-0", className)}>
      {label && (
        <p className={cn("mb-2 flex items-center gap-1.5 font-medium text-muted-foreground", prominent ? "mb-3 text-sm" : "text-xs")}>
          <Sparkles className="size-3.5" aria-hidden /> {label}
        </p>
      )}
      <ul className={cn("flex flex-wrap gap-2", prominent && "gap-2.5")}>
        {TRY_PROMPTS.map((p) => (
          <li key={p}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(p)}
              className={cn(
                "group inline-flex items-center gap-1.5 rounded-full border bg-card text-left transition-colors hover:border-primary/50 hover:bg-accent disabled:opacity-50",
                prominent ? "px-4 py-2 text-sm shadow-xs" : "px-3 py-1.5 text-sm",
              )}
            >
              {p}
              {prominent && <ArrowUpRight className="size-3.5 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
