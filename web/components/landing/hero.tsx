"use client";

import { MessageSquare, Mic } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Orb } from "@/components/orb/orb";
import { PersonaSwitcher } from "@/components/talk/persona-switcher";
import { TryChips } from "@/components/talk/try-chips";
import { Button } from "@/components/ui/button";
import { usePersona } from "@/lib/use-persona";

export function Hero() {
  const [persona, setPersona] = usePersona();
  const router = useRouter();
  // Same props on server and client (no reduced-motion branching in render: it would break hydration).
  // MotionConfig reducedMotion="user" in the root layout drops the movement for people who ask for less motion.
  const rise = (delay: number) => ({ initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.5, delay } });

  return (
    <section className="mx-auto grid w-full max-w-6xl items-center gap-8 px-4 pt-8 pb-16 md:grid-cols-[1.1fr_0.9fr] md:pt-16">
      <div className="order-2 md:order-1">
        <motion.p {...rise(0)} className="text-sm font-medium text-primary">
          Pearl Dental Care · Coimbatore
        </motion.p>
        <motion.h1 {...rise(0.05)} className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
          Meet Pearl, the AI front desk that never puts you on hold
        </motion.h1>
        <motion.p {...rise(0.1)} className="mt-4 max-w-xl text-lg text-muted-foreground text-pretty">
          Talk to her like a receptionist. She books, moves and cancels real appointments, answers clinic questions, and escalates
          anything urgent to a human, all running on this laptop.
        </motion.p>

        <motion.div {...rise(0.15)} className="mt-7 flex flex-wrap gap-3">
          <Button asChild size="lg" className="h-11 rounded-full px-6 text-base">
            <Link href="/talk?mode=voice" data-testid="cta-voice">
              <Mic /> Talk to Pearl
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="h-11 rounded-full px-6 text-base">
            <Link href="/talk?mode=chat" data-testid="cta-chat">
              <MessageSquare /> Prefer to chat?
            </Link>
          </Button>
        </motion.div>

        <motion.div {...rise(0.2)} className="mt-8 space-y-6">
          <PersonaSwitcher value={persona} onChange={setPersona} />
          <TryChips
            label="Things to try (opens a chat)"
            onPick={(p) => router.push(`/talk?mode=chat&prompt=${encodeURIComponent(p)}`)}
          />
        </motion.div>
      </div>

      <motion.div
        className="order-1 mx-auto w-full max-w-[220px] sm:max-w-xs md:order-2 md:max-w-md"
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
      >
        <Orb mode="idle" label="Pearl, the AI receptionist" />
      </motion.div>
    </section>
  );
}
