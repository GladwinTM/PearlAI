"use client";

import { AudioLines, Brain, Mic, Volume2 } from "lucide-react";
import { motion } from "motion/react";

import { BACKEND } from "@/lib/config";

// One voice turn, end to end. The copy follows the version that's running (the live site vs `make dev-local`).
const STEPS =
  BACKEND === "python"
    ? [
        { icon: Mic, title: "You speak", body: "Your browser streams the mic to the local server over WebRTC. Silero VAD spots when you've finished." },
        { icon: AudioLines, title: "Whisper listens", body: "MLX Whisper on the Apple GPU turns speech into text in about a tenth of a second." },
        {
          icon: Brain,
          title: "Pearl thinks and acts",
          body: "qwen3:8b calls real tools (availability, booking, search over the FAQ). Code guards block invented slots, and Postgres makes double booking impossible.",
        },
        { icon: Volume2, title: "Kokoro answers", body: "The first clause goes to TTS while the model is still writing, so Pearl starts talking sooner. Interrupt her any time." },
      ]
    : [
        { icon: Mic, title: "You speak", body: "Silero VAD runs in your browser and spots when you've finished, so only your words are sent." },
        { icon: AudioLines, title: "Whisper listens", body: "Whisper large-v3-turbo on Groq turns your speech into text in a fraction of a second." },
        {
          icon: Brain,
          title: "Pearl thinks and acts",
          body: "gpt-oss on Groq calls real tools (availability, booking, FAQ search). Code guards block invented slots, and Postgres makes double booking impossible.",
        },
        { icon: Volume2, title: "Pearl answers", body: "On desktop her voice is Kokoro, running in your browser; phones use the built-in voice. Interrupt her any time." },
      ];

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="border-y bg-muted/50 py-16 sm:py-20">
      <div className="mx-auto w-full max-w-6xl px-4">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-primary">Under the hood</p>
          <h2 id="how-title" className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">
            How it works
          </h2>
          <p className="mt-3 text-muted-foreground">One voice turn, end to end. The Inspector on the talk page shows every step live, with timings.</p>
        </div>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <motion.li
              key={s.title}
              className="brick rounded-2xl bg-card p-5"
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.4, ease: "easeOut", delay: i * 0.08 }}
            >
              <div className="flex items-center justify-between">
                <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
                  <s.icon className="size-5" aria-hidden />
                </span>
                <span className="text-sm font-medium text-muted-foreground tabular-nums" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="mt-4 font-semibold">
                <span className="sr-only">{i + 1}. </span>
                {s.title}
              </h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{s.body}</p>
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}
