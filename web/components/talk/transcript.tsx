"use client";

import { Check, Loader2, Mic, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

import { type Message, type Part, TOOL_LABEL } from "@/lib/talk";
import { cn } from "@/lib/utils";

const PAST: Record<string, string> = {
  lookup_patient: "Looked up patient",
  create_patient: "Registered patient",
  check_availability: "Checked availability",
  book_appointment: "Booked",
  list_appointments: "Listed appointments",
  reschedule_appointment: "Rescheduled",
  cancel_appointment: "Cancelled",
  get_clinic_info: "Searched clinic info",
  escalate_to_human: "Alerted staff",
};

interface Props {
  messages: Message[];
  empty?: React.ReactNode;
  className?: string;
}

/** The conversation: chat bubbles, voice captions and inline tool pills in one scrollable, live-announced list. */
export function Transcript({ messages, empty, className }: Props) {
  const reduce = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastLen = messages.length ? JSON.stringify(messages[messages.length - 1].parts).length : 0;

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [messages.length, lastLen, reduce]);

  return (
    <div
      ref={box}
      className={cn("min-h-0 overflow-y-auto", className)}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {messages.length === 0 ? (
        empty
      ) : (
        <ol className="space-y-3 px-1 py-2" aria-label="Conversation" aria-live="polite" aria-relevant="additions text" data-testid="transcript">
          {messages.map((m) => (
            <motion.li
              key={m.id}
              // Messages pop in with a quick spring from the speaker's side.
              initial={reduce ? false : { opacity: 0, y: 10, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 520, damping: 30 }}
              style={{ transformOrigin: m.role === "user" ? "100% 100%" : "0% 100%" }}
              className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
            >
              {m.role === "user" ? <UserBubble m={m} /> : <PearlBubble m={m} />}
            </motion.li>
          ))}
        </ol>
      )}
    </div>
  );
}

function UserBubble({ m }: { m: Message }) {
  const text = (m.parts[0] as Extract<Part, { kind: "text" }>)?.text ?? "";
  return (
    <div className={cn("max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground shadow-xs", m.interim && "opacity-70")}>
      <span className="sr-only">You said: </span>
      {m.channel === "voice" && <Mic className="mr-1.5 inline size-3.5 -translate-y-px opacity-80" aria-hidden />}
      {text}
      {m.interim && <span className="sr-only"> (still listening)</span>}
    </div>
  );
}

function PearlBubble({ m }: { m: Message }) {
  const texts = m.parts.filter((p) => p.kind === "text");
  const hasText = texts.some((p) => p.kind === "text" && p.text.trim());
  return (
    <div className="flex max-w-[90%] flex-col items-start gap-1.5">
      {m.parts.map((p, i) => {
        if (p.kind === "tool") return <ToolPill key={p.id} p={p} />;
        if (p.kind === "notice") return <Notice key={i} p={p} />;
        if (!p.text.trim()) return null;
        return (
          <div
            key={i}
            className={cn(
              "rounded-2xl rounded-bl-md border bg-muted/60 px-3.5 py-2",
              p.retracted && "border-dashed bg-transparent text-muted-foreground shadow-none",
            )}
          >
            <span className="sr-only">Pearl{p.retracted ? " (retracted)" : ""}: </span>
            {p.retracted ? (
              <>
                <del className="decoration-muted-foreground/60">{p.text}</del>
                <span className="mt-1 block text-xs">
                  {p.retractReason === "unsourced_fact"
                    ? "Retracted: Pearl answered a clinic question from memory, so she's looking it up."
                    : "Retracted: Pearl mentioned times no tool had returned, so she's checking first."}
                </span>
              </>
            ) : (
              <span className="whitespace-pre-wrap">{p.text}</span>
            )}
          </div>
        );
      })}
      {m.streaming && !hasText && <TypingDots />}
    </div>
  );
}

function ToolPill({ p }: { p: Extract<Part, { kind: "tool" }> }) {
  const running = p.ok === undefined;
  return (
    <span
      data-testid="tool-pill"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        running ? "border-primary/50 bg-accent text-accent-foreground" : p.ok ? "bg-card text-muted-foreground" : "border-destructive/50 text-destructive",
      )}
    >
      {running ? <Loader2 className="size-3 animate-spin" aria-hidden /> : p.ok ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
      {running ? `${TOOL_LABEL[p.name] ?? p.name}…` : p.ok ? (PAST[p.name] ?? p.name) : `${TOOL_LABEL[p.name] ?? p.name}: not done`}
      {p.auto && <span className="text-muted-foreground">(caller ID)</span>}
      {p.ms != null && <span className="tabular-nums text-muted-foreground">· {p.ms} ms</span>}
    </span>
  );
}

function Notice({ p }: { p: Extract<Part, { kind: "notice" }> }) {
  const Icon = p.tone === "safety" ? ShieldAlert : TriangleAlert;
  return (
    <span
      role={p.tone === "error" ? "alert" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-medium",
        p.tone === "safety" && "bg-destructive/10 text-destructive",
        p.tone === "error" && "bg-destructive/10 text-destructive",
        p.tone === "info" && "bg-muted text-muted-foreground",
      )}
    >
      <Icon className="size-3.5" aria-hidden /> {p.text}
    </span>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 rounded-2xl rounded-bl-md border bg-muted/60 px-3.5 py-3" aria-label="Pearl is typing">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}
