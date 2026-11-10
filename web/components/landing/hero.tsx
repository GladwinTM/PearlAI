"use client";

import { CalendarCheck, Check, MessageSquare, Mic, PhoneIncoming } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";

import { Tooth } from "@/components/pearl/tooth";
import { Button } from "@/components/ui/button";
import { BACKEND } from "@/lib/config";

// Same props on server and client (no reduced-motion branching in render: it would break hydration).
// MotionConfig reducedMotion="user" in the root layout drops the movement for people who ask for less motion.
// Movement only (no fade from 0): the text is painted at first render, which keeps Largest Contentful Paint fast.
const rise = (delay: number) => ({ initial: { y: 12 }, animate: { y: 0 }, transition: { duration: 0.4, ease: "easeOut" as const, delay } });

const WHERE = BACKEND === "python" ? "Runs entirely on this laptop." : "Her voice runs right in your browser.";
const POINTS = ["Books, moves and cancels real appointments", "Answers clinic questions from the FAQ", "Escalates urgent symptoms to a human"];

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden border-b">
      <div className="dots pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent_85%)]" aria-hidden />
      <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 py-12 md:grid-cols-[1.05fr_0.95fr] md:py-20 lg:gap-16">
        <div>
          <motion.p {...rise(0)} className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-xs">
            <span className="size-1.5 rounded-full bg-success" aria-hidden /> Pearl Dental Care · Coimbatore
          </motion.p>
          <motion.h1 {...rise(0.04)} id="hero-title" className="mt-5 text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
            Meet Pearl, the AI front desk that never puts you on hold
          </motion.h1>
          <motion.p {...rise(0.08)} className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
            Talk to her like a receptionist, by voice or chat. She checks the real calendar, confirms before she books, and
            hands anything urgent to the clinic team. {WHERE}
          </motion.p>
          <motion.ul {...rise(0.12)} className="mt-6 space-y-2 text-sm">
            {POINTS.map((p) => (
              <li key={p} className="flex items-center gap-2">
                <span className="grid size-5 place-items-center rounded-full bg-primary/10 text-primary" aria-hidden>
                  <Check className="size-3" strokeWidth={3} />
                </span>
                {p}
              </li>
            ))}
          </motion.ul>
          <motion.div {...rise(0.16)} className="mt-8 flex flex-wrap gap-3">
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

        {/* Pearl on her stage, with two glimpses of what she does. */}
        <motion.div
          className="relative mx-auto w-full max-w-md"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
        >
          <div className="stage brick overflow-hidden rounded-3xl">
            <Tooth mode="idle" label="Pearl, the AI receptionist: a friendly cartoon tooth" />
          </div>
          <div aria-hidden className="brick absolute top-6 -left-3 flex items-center gap-2.5 rounded-xl bg-card px-3 py-2 text-xs sm:-left-8">
            <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary">
              <PhoneIncoming className="size-3.5" />
            </span>
            <span>
              <span className="block font-medium">Caller ID: Ravi Kumar</span>
              <span className="text-muted-foreground">Existing patient</span>
            </span>
          </div>
          <div aria-hidden className="brick absolute -right-3 bottom-8 flex items-center gap-2.5 rounded-xl bg-card px-3 py-2 text-xs sm:-right-8">
            <span className="grid size-7 place-items-center rounded-lg bg-success/10 text-success">
              <CalendarCheck className="size-3.5" />
            </span>
            <span>
              <span className="block font-medium">Booked: checkup</span>
              <span className="text-muted-foreground">Dr. Priya · Fri 10:00 AM</span>
            </span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
