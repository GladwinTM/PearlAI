"use client";

import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";
import { type ReactNode, useEffect } from "react";

import { cn } from "@/lib/utils";

// Decorative stickers around the hero. They drift gently and lean away from the cursor (deeper ones move more).
// aria-hidden: pure decoration.

function Sparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className}>
      <path d="M20 1C21.5 13 27 18.5 39 20C27 21.5 21.5 27 20 39C18.5 27 13 21.5 1 20C13 18.5 18.5 13 20 1Z" fill="var(--yellow)" stroke="var(--edge)" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function Heart({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 36" className={className}>
      <path d="M20 34C8 25 2 18 2 11C2 5.5 6.5 2 11.5 2C15 2 18 4 20 7C22 4 25 2 28.5 2C33.5 2 38 5.5 38 11C38 18 32 25 20 34Z" fill="var(--pink)" stroke="var(--edge)" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function Toothbrush({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 34" className={className}>
      <rect x="2" y="16" width="86" height="12" rx="6" fill="var(--coral)" stroke="var(--edge)" strokeWidth="2" />
      <rect x="80" y="18" width="36" height="9" rx="4.5" fill="var(--card)" stroke="var(--edge)" strokeWidth="2" />
      {[84, 91, 98, 105].map((x) => (
        <rect key={x} x={x} y="3" width="5" height="15" rx="2.5" fill="var(--sky)" stroke="var(--edge)" strokeWidth="1.6" />
      ))}
    </svg>
  );
}

function Ring({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className}>
      <circle cx="20" cy="20" r="14" fill="none" stroke="var(--lavender)" strokeWidth="8" />
      <circle cx="20" cy="20" r="18" fill="none" stroke="var(--edge)" strokeWidth="2" />
      <circle cx="20" cy="20" r="10" fill="none" stroke="var(--edge)" strokeWidth="2" />
    </svg>
  );
}

function Blob({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className}>
      <path d="M8 10C14 1 30 2 35 11C40 20 34 36 21 37C8 38 2 19 8 10Z" fill="var(--lime)" stroke="var(--edge)" strokeWidth="2" />
    </svg>
  );
}

interface Spec {
  node: ReactNode;
  className: string; // position + size
  depth: number; // parallax strength
  rotate: number;
  float: number; // seconds per bob
}

const STICKERS: Spec[] = [
  { node: <Sparkle className="size-full" />, className: "left-[6%] top-[14%] size-12 sm:size-16", depth: 26, rotate: -8, float: 3.2 },
  { node: <Heart className="size-full" />, className: "right-[8%] top-[18%] size-11 sm:size-14", depth: 34, rotate: 12, float: 3.8 },
  { node: <Toothbrush className="size-full" />, className: "left-[4%] bottom-[24%] hidden h-10 w-36 sm:block", depth: 18, rotate: -16, float: 4.4 },
  { node: <Ring className="size-full" />, className: "right-[5%] bottom-[30%] hidden size-16 sm:block", depth: 22, rotate: 0, float: 3.6 },
  { node: <Blob className="size-full" />, className: "left-[22%] top-[6%] hidden size-9 md:block", depth: 12, rotate: 20, float: 4.8 },
  { node: <Sparkle className="size-full" />, className: "right-[24%] top-[8%] hidden size-8 md:block", depth: 40, rotate: 14, float: 2.8 },
  { node: <Sparkle className="size-full" />, className: "right-[6%] bottom-[8%] size-7", depth: 30, rotate: -10, float: 3.4 },
  { node: <Heart className="size-full" />, className: "left-[14%] bottom-[10%] hidden size-8 sm:block", depth: 16, rotate: -14, float: 4.1 },
];

function Sticker({ s, x, y, index, still }: { s: Spec; x: MotionValue<number>; y: MotionValue<number>; index: number; still: boolean }) {
  const tx = useTransform(x, (v) => v * -s.depth);
  const ty = useTransform(y, (v) => v * -s.depth);
  return (
    <motion.div className={cn("pointer-events-none absolute", s.className)} style={{ x: tx, y: ty }}>
      <motion.div
        initial={{ scale: 0, rotate: s.rotate - 30 }}
        animate={still ? { scale: 1, rotate: s.rotate } : { scale: 1, rotate: s.rotate, y: [0, -8, 0] }}
        transition={{
          scale: { type: "spring", stiffness: 420, damping: 16, delay: 0.35 + index * 0.06 },
          rotate: { type: "spring", stiffness: 300, damping: 14, delay: 0.35 + index * 0.06 },
          y: { duration: s.float, repeat: Infinity, ease: "easeInOut" },
        }}
        className="size-full drop-shadow-[0_4px_0_var(--edge)]"
      >
        {s.node}
      </motion.div>
    </motion.div>
  );
}

export function Stickers() {
  const still = useReducedMotion() ?? false;
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const x = useSpring(rawX, { stiffness: 120, damping: 20 });
  const y = useSpring(rawY, { stiffness: 120, damping: 20 });

  useEffect(() => {
    if (still) return;
    const move = (e: PointerEvent) => {
      rawX.set((e.clientX / window.innerWidth - 0.5) * 2);
      rawY.set((e.clientY / window.innerHeight - 0.5) * 2);
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [still, rawX, rawY]);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {STICKERS.map((s, i) => (
        <Sticker key={i} s={s} x={x} y={y} index={i} still={still} />
      ))}
    </div>
  );
}
