"use client";

import { AudioLines, Brain, Mic, Volume2 } from "lucide-react";
import { motion } from "motion/react";

import { BACKEND } from "@/lib/config";
import { cn } from "@/lib/utils";

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
        { icon: Volume2, title: "Kokoro answers", body: "Pearl's voice is Kokoro, running in your browser. Her first clause is spoken while the model is still writing. Interrupt her any time." },
      ];

const FILL = ["bg-yellow", "bg-lime", "bg-lavender", "bg-pink"];

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="border-y-2 border-edge bg-deep py-16 text-white sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-4">
        <motion.h2
          id="how-title"
          className="font-display text-5xl leading-[0.9] font-bold uppercase sm:text-7xl"
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ type: "spring", stiffness: 300, damping: 24 }}
        >
          How it works
        </motion.h2>
        <p className="mt-3 max-w-2xl text-lg text-white/85">
          One voice turn, end to end. The Inspector on the talk page shows every step live, with timings.
        </p>
        <ol className="mt-10 grid gap-5 md:grid-cols-2">
          {STEPS.map((s, i) => (
            <motion.li
              key={s.title}
              className={cn("brick rounded-[2rem] p-6 text-deep sm:p-8", FILL[i])}
              initial={{ opacity: 0, y: 40, rotate: i % 2 ? 2 : -2 }}
              whileInView={{ opacity: 1, y: 0, rotate: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ type: "spring", stiffness: 260, damping: 22, delay: (i % 2) * 0.08 }}
            >
              <div className="flex items-center justify-between">
                <span className="font-display text-6xl leading-none font-bold sm:text-7xl" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="brick grid size-14 place-items-center rounded-2xl bg-card text-foreground [--brick-depth:3px]">
                  <s.icon className="size-6" aria-hidden />
                </span>
              </div>
              <h3 className="mt-5 font-display text-3xl leading-none font-bold uppercase sm:text-4xl">
                <span className="sr-only">{i + 1}. </span>
                {s.title}
              </h3>
              <p className="mt-3 text-base font-medium">{s.body}</p>
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}
