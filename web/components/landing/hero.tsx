"use client";

import { MessageSquare, Mic } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";

import { Tooth } from "@/components/pearl/tooth";
import { Button } from "@/components/ui/button";
import { BACKEND } from "@/lib/config";

import { Stickers } from "./stickers";

// Same props on server and client (no reduced-motion branching in render: it would break hydration).
// MotionConfig reducedMotion="user" in the root layout drops the movement for people who ask for less motion.
const word = (delay: number) => ({
  initial: { y: "0.35em", rotate: -4 },
  animate: { y: 0, rotate: 0 },
  transition: { type: "spring" as const, stiffness: 380, damping: 22, delay },
});
// Movement only (no fade from 0): the text is painted at first render, which keeps Largest Contentful Paint fast.
const rise = (delay: number) => ({ initial: { y: 14 }, animate: { y: 0 }, transition: { duration: 0.35, delay } });

const WHERE = BACKEND === "python" ? "all running on this laptop" : "and her voice runs right in your browser";

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="on-sky relative isolate overflow-hidden border-b-2 border-edge bg-sky studs text-deep">
      <Stickers />
      <div className="relative mx-auto flex min-h-[calc(100svh-4rem)] max-w-[1400px] flex-col items-center justify-center px-4 pt-8 pb-12 text-center">
        <motion.p {...rise(0)} className="brick inline-flex items-center gap-2 rounded-full bg-yellow px-4 py-1.5 text-sm font-bold [--brick-depth:3px]">
          Pearl Dental Care · Coimbatore
        </motion.p>

        <div className="relative mt-4 w-full">
          <h1
            id="hero-title"
            className="font-display text-[clamp(5.2rem,19vw,17rem)] leading-[0.8] font-bold tracking-[-0.02em] uppercase text-brick"
          >
            <motion.span {...word(0.05)} className="block">
              Meet
            </motion.span>{" "}
            <motion.span {...word(0.15)} className="mt-[0.42em] block">
              Pearl
            </motion.span>
          </h1>
          {/* Pearl sits between (and over) the two words. */}
          <motion.div
            className="pointer-events-none absolute top-1/2 left-1/2 w-[clamp(140px,34vw,470px)] -translate-x-1/2 -translate-y-[47%]"
            initial={{ opacity: 0, scale: 0.4, y: -60 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 13, delay: 0.3 }}
          >
            <Tooth mode="idle" label="Pearl, the AI receptionist: a smiling cartoon tooth" />
          </motion.div>
        </div>

        <motion.p {...rise(0.35)} className="mt-6 max-w-xl text-lg font-medium text-pretty sm:text-xl">
          The AI front desk that never puts you on hold. She books, moves and cancels real appointments, answers clinic questions,
          and escalates anything urgent to a human, {WHERE}.
        </motion.p>

        <motion.div {...rise(0.45)} className="mt-7 flex flex-wrap justify-center gap-4">
          <Button asChild size="lg">
            <Link href="/talk?mode=voice" data-testid="cta-voice">
              <Mic /> Talk to Pearl
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/talk?mode=chat" data-testid="cta-chat">
              <MessageSquare /> Prefer to chat?
            </Link>
          </Button>
        </motion.div>
      </div>
    </section>
  );
}
