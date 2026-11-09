"use client";

import { useEffect, useRef, useState } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { Tooth } from "./tooth";
import { ToothMark, type ToothFace } from "./tooth-mark";
import type { ToothExpression, ToothMode } from "./types";

const MODES: ToothMode[] = ["idle", "listening", "thinking", "speaking"];
const EXPRESSIONS: ToothExpression[] = ["wink", "worried", "heart"];
const FACES: ToothFace[] = ["smile", "open", "up", "wink", "worried", "confused", "sleepy"];

const STATES: { title: string; note: string; mode: ToothMode; expression: ToothExpression | null; bg: string }[] = [
  { title: "Idle", note: "Floats, breathes, blinks; eyes follow your cursor", mode: "idle", expression: null, bg: "bg-sky" },
  { title: "Listening", note: "Leans in, eyes wide, glove cupped; squashes with the mic", mode: "listening", expression: null, bg: "bg-lime" },
  { title: "Thinking", note: "Eyes up, wobble, orbiting sparkles", mode: "thinking", expression: null, bg: "bg-lavender" },
  { title: "Speaking", note: "Mouth opens and bounces with her voice", mode: "speaking", expression: null, bg: "bg-yellow" },
  { title: "Booking confirmed", note: "Wink, peace sign, sparkle burst", mode: "idle", expression: "wink", bg: "bg-ice" },
  { title: "Urgent", note: "Squinting eyes, wavy mouth, hands on head", mode: "idle", expression: "worried", bg: "bg-coral" },
  { title: "Thank you / goodbye", note: "Holds a pink heart", mode: "idle", expression: "heart", bg: "bg-pink" },
];

/** A fake audio level, like speech: syllable bursts with pauses. */
function useFakeLevel(on: boolean) {
  const level = useRef(0);
  useEffect(() => {
    if (!on) {
      level.current = 0;
      return;
    }
    let raf = 0;
    const tick = (now: number) => {
      const t = now / 1000;
      const syllables = Math.abs(Math.sin(t * 9.5)) * (0.55 + 0.45 * Math.sin(t * 2.1));
      level.current = Math.max(0, syllables * (Math.sin(t * 0.9) > -0.6 ? 0.45 : 0.02));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return level;
}

export function ToothLab() {
  const [mode, setMode] = useState<ToothMode>("idle");
  const [expression, setExpression] = useState<ToothExpression | null>(null);
  const [hold, setHold] = useState(false);
  const [audio, setAudio] = useState(true);
  const [still, setStill] = useState(false);
  const level = useFakeLevel(audio);
  const gridLevel = useFakeLevel(true);

  // In the app an expression is a one-off: it clears after a moment (unless "hold" is on here).
  useEffect(() => {
    if (!expression || hold) return;
    const t = setTimeout(() => setExpression(null), 2600);
    return () => clearTimeout(t);
  }, [expression, hold]);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">SmileDesk · dev</p>
          <h1 className="text-3xl font-bold tracking-tight">Pearl tooth lab</h1>
        </div>
        <ThemeToggle />
      </header>

      <section className="mt-6 grid gap-6 lg:grid-cols-[1.3fr_1fr]" aria-label="Playground">
        <div className="rounded-[2rem] bg-sky p-4">
          <Tooth mode={mode} expression={expression} level={level} still={still} className="mx-auto max-w-[520px]" />
        </div>
        <div className="space-y-5">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Mode</legend>
            <div className="flex flex-wrap gap-2">
              {MODES.map((m) => (
                <Button key={m} variant={mode === m ? "default" : "outline"} onClick={() => setMode(m)}>
                  {m}
                </Button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Expression (a one-off: clears after 2.6 s)</legend>
            <div className="flex flex-wrap gap-2">
              {EXPRESSIONS.map((e) => (
                <Button key={e} variant={expression === e ? "default" : "outline"} onClick={() => setExpression(e)}>
                  {e}
                </Button>
              ))}
              <Button variant="ghost" onClick={() => setExpression(null)}>
                clear
              </Button>
            </div>
          </fieldset>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /> Hold the expression
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} /> Simulated audio level (listening /
              speaking)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={still} onChange={(e) => setStill(e.target.checked)} /> Still pose (what reduced motion shows)
            </label>
          </div>
          <p className="text-sm text-muted-foreground">
            Move your cursor around the page: in idle, listening and speaking Pearl&apos;s eyes and body follow it.
          </p>
        </div>
      </section>

      <section className="mt-12" aria-labelledby="states">
        <h2 id="states" className="text-xl font-bold">
          Every state
        </h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STATES.map((s) => (
            <li key={s.title} className={cn("rounded-[1.75rem] p-3 text-deep", s.bg)}>
              <Tooth mode={s.mode} expression={s.expression} level={gridLevel} />
              <p className="mt-1 font-bold">{s.title}</p>
              <p className="text-sm">{s.note}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12" aria-labelledby="marks">
        <h2 id="marks" className="text-xl font-bold">
          Static tooth (poster, logo, favicon, persona cards)
        </h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {(["bg-ice", "bg-deep"] as const).map((bg) => (
            <div key={bg} className={cn("rounded-[1.75rem] p-5", bg)}>
              <div className="flex flex-wrap items-end gap-4">
                {FACES.map((f) => (
                  <figure key={f} className="text-center">
                    <ToothMark face={f} className="h-20 w-auto" />
                    <figcaption className={cn("mt-1 text-xs", bg === "bg-deep" ? "text-white" : "text-deep")}>{f}</figcaption>
                  </figure>
                ))}
              </div>
              <div className="mt-5 flex items-end gap-4">
                <ToothMark outline className="size-4" />
                <ToothMark outline className="size-6" />
                <ToothMark outline className="size-8" />
                <span className="flex items-end" aria-label="Ravi for Meena: a big tooth and a baby tooth">
                  <ToothMark className="h-16 w-auto" />
                  <ToothMark face="open" className="-ml-2 h-9 w-auto" />
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
