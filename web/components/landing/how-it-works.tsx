"use client";

import { AudioLines, Brain, Mic, Volume2 } from "lucide-react";
import { motion } from "motion/react";

const STEPS = [
  { icon: Mic, title: "You speak", body: "Your browser streams the mic to the local server over WebRTC. Silero VAD spots when you've finished." },
  { icon: AudioLines, title: "Whisper listens", body: "MLX Whisper on the Apple GPU turns speech into text in about a tenth of a second." },
  {
    icon: Brain,
    title: "Pearl thinks and acts",
    body: "qwen3:8b calls real tools (availability, booking, RAG over the FAQ). Code guards block invented slots, and Postgres makes double booking impossible.",
  },
  { icon: Volume2, title: "Kokoro answers", body: "The first clause goes to TTS while the model is still writing, so Pearl starts talking sooner. Interrupt her any time." },
];

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="mx-auto w-full max-w-6xl px-4 py-16">
      <h2 id="how-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
        How it works
      </h2>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        One voice turn, end to end. The Inspector on the talk page shows every step live, with timings.
      </p>
      <ol className="relative mt-10 grid gap-6 md:grid-cols-4">
        <motion.span
          aria-hidden
          className="absolute top-6 left-6 hidden h-px origin-left bg-gradient-to-r from-primary/60 via-primary/30 to-transparent md:block"
          style={{ right: "1.5rem" }}
          initial={{ scaleX: 0 }}
          whileInView={{ scaleX: 1 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 1.2, ease: "easeInOut" }}
        />
        {STEPS.map((s, i) => (
          <motion.li
            key={s.title}
            className="relative"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.45, delay: i * 0.15 }}
          >
            <span className="relative z-10 grid size-12 place-items-center rounded-2xl border bg-card text-primary shadow-sm">
              <s.icon className="size-5" aria-hidden />
            </span>
            <h3 className="mt-4 font-medium">
              <span className="mr-1.5 text-muted-foreground">{i + 1}.</span>
              {s.title}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
          </motion.li>
        ))}
      </ol>
    </section>
  );
}
