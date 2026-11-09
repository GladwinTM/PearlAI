"use client";

import { Sparkles } from "lucide-react";
import { motion } from "motion/react";

import { TRY_PROMPTS } from "@/lib/personas";
import { cn } from "@/lib/utils";

interface Props {
  onPick: (prompt: string) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
  /** Big tilted stickers that pop in (landing page). */
  stickers?: boolean;
}

const STICKER = ["bg-yellow", "bg-pink", "bg-lime", "bg-card", "bg-lavender"];
const TILT = [-3, 2.5, -1.5, 3, -2.5];

export function TryChips({ onPick, disabled, label = "Things to try", className, stickers }: Props) {
  return (
    <div className={cn("min-w-0", className)}>
      {label && (
        <p className={cn("mb-2 flex items-center gap-1.5 font-medium", stickers ? "justify-center text-sm" : "text-xs text-muted-foreground")}>
          <Sparkles className="size-3.5" aria-hidden /> {label}
        </p>
      )}
      <ul className={cn("flex flex-wrap gap-2", stickers && "justify-center gap-3 sm:gap-4")}>
        {TRY_PROMPTS.map((p, i) => (
          <motion.li
            key={p}
            initial={stickers ? { scale: 0, rotate: TILT[i] * 4 } : false}
            whileInView={stickers ? { scale: 1, rotate: TILT[i] } : undefined}
            viewport={{ once: true, margin: "-40px" }}
            transition={{ type: "spring", stiffness: 480, damping: 15, delay: i * 0.06 }}
            whileHover={stickers ? { rotate: 0, scale: 1.04 } : undefined}
          >
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(p)}
              className={cn(
                "text-left transition-colors disabled:opacity-50",
                stickers
                  ? cn("brick press rounded-2xl px-4 py-2.5 text-base font-semibold text-deep [--brick-depth:4px]", STICKER[i % STICKER.length], STICKER[i % STICKER.length] === "bg-card" && "text-foreground")
                  : "rounded-full border-2 border-edge-soft bg-card px-3 py-1.5 text-sm hover:border-primary/60 hover:bg-accent",
              )}
            >
              {p}
            </button>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}
