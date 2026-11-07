"use client";

import { Sparkles } from "lucide-react";

import { TRY_PROMPTS } from "@/lib/personas";
import { cn } from "@/lib/utils";

interface Props {
  onPick: (prompt: string) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}

export function TryChips({ onPick, disabled, label = "Things to try", className }: Props) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden /> {label}
      </p>
      <ul className="flex flex-wrap gap-2">
        {TRY_PROMPTS.map((p) => (
          <li key={p}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(p)}
              className="rounded-full border bg-card px-3 py-1.5 text-left text-sm transition-colors hover:border-primary/60 hover:bg-accent disabled:opacity-50"
            >
              {p}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
