"use client";

import { Mic, MessageSquare, PhoneOff, Volume2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { RefObject } from "react";

import { Orb, type OrbMode } from "@/components/orb/orb";
import { Button } from "@/components/ui/button";
import type { VoiceStatus } from "@/lib/use-voice";

interface Props {
  status: VoiceStatus;
  orb: OrbMode;
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

const STATUS: Record<OrbMode, string> = {
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
      <div className="relative w-full max-w-[min(320px,60vw)]">
        <Orb mode={live ? p.orb : p.status === "connecting" ? "thinking" : "idle"} level={p.level} />
      </div>

      {live && (p.waiting || p.orb === "thinking") ? (
        <p
          className="inline-flex items-center gap-2 rounded-full bg-accent px-3 py-1 text-sm font-medium text-accent-foreground"
          aria-live="polite"
          data-testid="voice-status"
        >
          <span className="size-2 animate-pulse rounded-full bg-primary" aria-hidden />
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
            className="w-full max-w-md rounded-2xl border bg-card p-4 text-left shadow-sm"
            role="region"
            aria-label="Microphone permission"
          >
            <p className="font-medium">Your browser will ask to use the microphone</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Audio goes only to the SmileDesk server on this machine and isn&apos;t recorded. Speak naturally; you can interrupt Pearl
              at any time. Headphones help.
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
            <Button variant="destructive" size="lg" onClick={p.onEnd} className="rounded-full px-5">
              <PhoneOff /> End call
            </Button>
            <span className="tabular-nums text-sm text-muted-foreground" aria-label={`Call time ${clock(p.seconds)} of ${clock(p.maxSeconds)}`}>
              {clock(p.seconds)} / {clock(p.maxSeconds)}
            </span>
          </motion.div>
        ) : (
          <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Button size="lg" onClick={p.onExplain} disabled={p.status === "connecting"} className="rounded-full px-6" data-testid="start-call">
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
        <div role="alert" className="w-full max-w-md rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-left text-sm">
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
            className="w-full max-w-md rounded-2xl border border-primary/40 bg-accent p-3 text-left"
            role="status"
          >
            <p className="text-xs font-medium text-muted-foreground">Try saying</p>
            <p className="text-base">&ldquo;{p.suggestion}&rdquo;</p>
            <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={p.onDismissSuggestion}>
              Dismiss
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
