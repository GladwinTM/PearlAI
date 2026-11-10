"use client";

import { ArrowUp } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import type { ToothExpression } from "@/components/pearl/tooth";
import { ToothMark, type ToothFace } from "@/components/pearl/tooth-mark";
import { Button } from "@/components/ui/button";

/** The small tooth by the composer (chat mode): static SVG, no WebGL. Looks up while Pearl works, reacts to events. */
function ChatBuddy({ busy, expression }: { busy: boolean; expression: ToothExpression | null }) {
  const face: ToothFace = expression === "wink" ? "wink" : expression === "worried" ? "worried" : expression === "heart" ? "smile" : busy ? "up" : "smile";
  return (
    <motion.div
      aria-hidden
      className="relative hidden shrink-0 self-end pb-1 sm:block"
      animate={busy ? { y: [0, -4, 0], rotate: [0, -4, 4, 0] } : { y: 0, rotate: 0 }}
      transition={busy ? { duration: 0.9, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
    >
      <motion.div key={expression ?? "none"} initial={expression ? { scale: 0.7 } : false} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 500, damping: 12 }}>
        <ToothMark face={face} className="h-11 w-auto" />
      </motion.div>
      {expression === "heart" && (
        <motion.svg
          viewBox="0 0 40 36"
          className="absolute -top-3 -right-2 size-5"
          initial={{ scale: 0, y: 6 }}
          animate={{ scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 12 }}
        >
          <path d="M20 34C8 25 2 18 2 11C2 5.5 6.5 2 11.5 2C15 2 18 4 20 7C22 4 25 2 28.5 2C33.5 2 38 5.5 38 11C38 18 32 25 20 34Z" fill="var(--heart)" />
        </motion.svg>
      )}
    </motion.div>
  );
}

export function Composer({ onSend, busy, expression = null }: { onSend: (text: string) => void; busy: boolean; expression?: ToothExpression | null }) {
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim() || busy) return;
    onSend(text);
    setText("");
  };
  return (
    <div className="flex items-end gap-2">
      <ChatBuddy busy={busy} expression={expression} />
      <form
        className="brick-soft flex min-w-0 flex-1 items-end gap-2 rounded-2xl bg-card p-2 focus-within:border-primary"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="composer" className="sr-only">
          Message Pearl
        </label>
        <textarea
          id="composer"
          rows={1}
          value={text}
          maxLength={1000}
          placeholder="Message Pearl…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Button type="submit" size="icon" disabled={busy || !text.trim()} aria-label="Send">
          <ArrowUp />
        </Button>
      </form>
    </div>
  );
}
