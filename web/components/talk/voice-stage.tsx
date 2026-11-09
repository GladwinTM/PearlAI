"use client";

import { Mic, MessageSquare, PhoneOff, Volume2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { RefObject } from "react";

import { Tooth, type ToothExpression, type ToothMode } from "@/components/pearl/tooth";
import { Button } from "@/components/ui/button";
import { BACKEND } from "@/lib/config";
import type { VoiceStatus } from "@/lib/use-voice";

interface Props {
  status: VoiceStatus;
  orb: ToothMode;
  /** Pearl's one-off reaction (booking confirmed, urgent, thank you). */
  expression?: ToothExpression | null;
  level: RefObject<number>;
  seconds: number;
  maxSeconds: number;
  explaining: boolean;
  error: { message: string; micDenied?: boolean } | null;
  audioBlocked: boolean;
  engine?: string;
  /** A request is being worked on and Pearl isn't talking yet. */
  waiting?: boolean;
  suggestion: string | null;
  onExplain: () => void;
  onCancelExplain: () => void;
  onStart: () => void;
  onEnd: () => void;
  onEnableAudio: () => void;
  onSwitchToChat: () => void;
  onDismissSuggestion: () => void;
}

const STATUS: Record<ToothMode, string> = {
  idle: "Ready when you are",
  listening: "Listening…",
  thinking: "Pearl is looking into it…",
  speaking: "Pearl is speaking",
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function VoiceStage(p: Props) {
  const live = p.status === "live";
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="on-sky studs w-full rounded-[1.5rem] border-2 border-edge-soft bg-sky">
        <Tooth
          mode={live ? p.orb : p.status === "connecting" ? "thinking" : "idle"}
          level={p.level}
          expression={p.expression}
          maxFps={live ? 30 : undefined} // a call: leave CPU for in-browser speech detection
          className="mx-auto max-w-[min(300px,62vw)]"
        />
      </div>

      {live && (p.waiting || p.orb === "thinking") ? (
        <p
          className="brick inline-flex items-center gap-2 rounded-full bg-yellow px-3.5 py-1 text-sm font-semibold text-deep [--brick-depth:3px]"
          aria-live="polite"
          data-testid="voice-status"
        >
          <span className="size-2 animate-pulse rounded-full bg-deep" aria-hidden />
          Pearl is looking into it… please hold on a moment
        </p>
      ) : (
        <p className="h-5 text-sm text-muted-foreground" aria-live="polite" data-testid="voice-status">
          {p.status === "connecting" ? "Connecting… Pearl will greet you in a second" : live ? STATUS[p.orb] : p.status === "ended" ? "Call ended" : ""}
        </p>
      )}

      <AnimatePresence mode="wait">
        {p.explaining && !live ? (
          <motion.div
            key="explain"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="brick w-full max-w-md rounded-[1.5rem] bg-card p-4 text-left"
            role="region"
            aria-label="Microphone permission"
          >
            <p className="font-display text-lg font-bold">Your browser will ask to use the microphone</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {BACKEND === "python"
                ? "Audio goes only to the SmileDesk server on this machine and isn't recorded."
                : "Your browser detects when you speak; each finished sentence is sent for transcription and isn't stored by SmileDesk."}{" "}
              Speak naturally; you can interrupt Pearl at any time. Headphones help.
            </p>
            <div className="mt-3 flex gap-2">
              <Button onClick={p.onStart} autoFocus>
                <Mic /> Allow mic and call
              </Button>
              <Button variant="ghost" onClick={p.onCancelExplain}>
                Not now
              </Button>
            </div>
          </motion.div>
        ) : live ? (
          <motion.div key="live" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3">
            <Button variant="destructive" size="lg" onClick={p.onEnd}>
              <PhoneOff /> End call
            </Button>
            <span className="tabular-nums text-sm text-muted-foreground" aria-label={`Call time ${clock(p.seconds)} of ${clock(p.maxSeconds)}`}>
              {clock(p.seconds)} / {clock(p.maxSeconds)}
            </span>
          </motion.div>
        ) : (
          <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Button size="lg" onClick={p.onExplain} disabled={p.status === "connecting"} data-testid="start-call">
              <Mic /> {p.status === "ended" || p.status === "error" ? "Call again" : "Talk to Pearl"}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {p.engine && p.status === "live" && <p className="text-xs text-muted-foreground">{p.engine}</p>}

      {p.audioBlocked && (
        <Button variant="secondary" onClick={p.onEnableAudio}>
          <Volume2 /> Your browser paused Pearl&apos;s audio. Click to enable sound
        </Button>
      )}

      {p.error && (
        <div role="alert" className="brick w-full max-w-md rounded-2xl bg-card p-3 text-left text-sm [--brick-depth:3px]">
          <p>{p.error.message}</p>
          <Button variant="link" className="h-auto px-0" onClick={p.onSwitchToChat}>
            <MessageSquare /> Continue in chat
          </Button>
        </div>
      )}

      <AnimatePresence>
        {p.suggestion && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className="brick w-full max-w-md rounded-[1.5rem] bg-lime p-3 text-left text-deep [--brick-depth:3px]"
            role="status"
          >
            <p className="text-xs font-semibold">Try saying</p>
            <p className="text-base">&ldquo;{p.suggestion}&rdquo;</p>
            <Button variant="link" size="sm" className="h-auto px-0 text-xs text-deep" onClick={p.onDismissSuggestion}>
              Dismiss
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
