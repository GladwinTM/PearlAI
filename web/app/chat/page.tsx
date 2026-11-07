"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { type AgentEvent, resetDemo, streamChat } from "@/lib/chat";
import { PERSONAS, TRY_PROMPTS } from "@/lib/personas";

// M2: minimal chat harness for exercising the agent core. The designed /talk experience arrives in M4.

type Part =
  | { kind: "text"; text: string; retracted?: boolean }
  | { kind: "tool"; id: string; name: string; auto?: boolean; ms?: number; ok?: boolean }
  | { kind: "safety"; rules: string[] }
  | { kind: "error"; message: string };

interface Msg {
  role: "user" | "assistant";
  parts: Part[];
  meta?: string;
}

const TOOL_LABEL: Record<string, string> = {
  lookup_patient: "Looking up patient",
  create_patient: "Registering patient",
  check_availability: "Checking availability",
  book_appointment: "Booking",
  list_appointments: "Listing appointments",
  reschedule_appointment: "Rescheduling",
  cancel_appointment: "Cancelling",
  get_clinic_info: "Searching clinic info",
  escalate_to_human: "Alerting staff",
};

function applyEvent(msg: Msg, e: AgentEvent): Msg {
  const parts = [...msg.parts];
  const last = parts[parts.length - 1];
  switch (e.type) {
    case "token":
      if (last?.kind === "text" && !last.retracted) parts[parts.length - 1] = { ...last, text: last.text + e.text };
      else parts.push({ kind: "text", text: e.text });
      break;
    case "retract": {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.kind === "text" && !p.retracted) {
          parts[i] = { ...p, retracted: true };
          break;
        }
      }
      break;
    }
    case "tool_call":
      parts.push({ kind: "tool", id: e.id, name: e.name, auto: e.auto });
      break;
    case "tool_result": {
      const i = parts.findIndex((p) => p.kind === "tool" && p.id === e.id);
      if (i >= 0) parts[i] = { ...(parts[i] as Extract<Part, { kind: "tool" }>), ms: e.ms, ok: !("error" in e.result) };
      break;
    }
    case "safety":
      parts.push({ kind: "safety", rules: e.rules });
      break;
    case "error":
      parts.push({ kind: "error", message: e.message });
      break;
    case "done": {
      const t = e.timings ?? {};
      return { ...msg, parts, meta: `${t.total_ms ?? "?"} ms total · ${t.rounds ?? "?"} rounds${e.outcome ? ` · ${e.outcome}` : ""}` };
    }
  }
  return { ...msg, parts };
}

export default function ChatPage() {
  const [persona, setPersona] = useState("ravi");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [log, setLog] = useState<AgentEvent[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", parts: [{ kind: "text", text: message }] }, { role: "assistant", parts: [] }]);
    try {
      await streamChat({ message, conversation_id: conversationId, persona }, (e) => {
        if (e.type === "conversation") {
          setConversationId(e.conversation_id);
          return;
        }
        if (e.type !== "token") setLog((l) => [...l, e]);
        setMessages((m) => [...m.slice(0, -1), applyEvent(m[m.length - 1], e)]);
        bottom.current?.scrollIntoView({ block: "end" });
      });
    } catch (err) {
      setMessages((m) => [...m.slice(0, -1), applyEvent(m[m.length - 1], { type: "error", message: String((err as Error).message) })]);
    } finally {
      setBusy(false);
    }
  }

  function newConversation(nextPersona = persona) {
    setPersona(nextPersona);
    setConversationId(null);
    setMessages([]);
    setLog([]);
  }

  async function onReset() {
    setStatus("Resetting…");
    try {
      await resetDemo();
      newConversation();
      setStatus("Demo data reset.");
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-[1fr_380px]">
      <section className="flex min-h-[70vh] flex-col gap-4">
        <header className="flex flex-wrap items-center gap-3">
          <Link href="/" className="text-sm underline">
            ← Status
          </Link>
          <h1 className="text-2xl font-semibold">Chat with Pearl</h1>
          <label className="ml-auto flex items-center gap-2 text-sm">
            I am
            <select
              className="rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700"
              value={persona}
              onChange={(e) => newConversation(e.target.value)}
            >
              {PERSONAS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.description})
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="rounded border border-slate-300 px-3 py-1 text-sm dark:border-slate-700" onClick={() => newConversation()}>
            New chat
          </button>
          <button type="button" className="rounded border border-slate-300 px-3 py-1 text-sm dark:border-slate-700" onClick={onReset}>
            Reset demo
          </button>
        </header>
        {status && (
          <p role="status" className="text-sm text-slate-500">
            {status}
          </p>
        )}

        <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-slate-200 p-4 dark:border-slate-800" aria-live="polite">
          {messages.length === 0 && <p className="text-slate-500">Say hello, or pick one of the prompts below.</p>}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "text-right" : ""}>
              <div
                className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-left ${
                  m.role === "user" ? "bg-teal-700 text-white" : "bg-slate-100 dark:bg-slate-800"
                }`}
              >
                {m.parts.length === 0 && <span className="text-slate-500">Pearl is typing…</span>}
                {m.parts.map((p, j) => {
                  if (p.kind === "text")
                    return (
                      <span key={j} className={p.retracted ? "text-slate-400 line-through" : ""} title={p.retracted ? "Retracted: not grounded in a tool result" : undefined}>
                        {p.text}{" "}
                      </span>
                    );
                  if (p.kind === "tool")
                    return (
                      <span key={j} className="my-1 mr-1 inline-block rounded-full border border-teal-600 px-2 py-0.5 text-xs text-teal-800 dark:text-teal-200">
                        {TOOL_LABEL[p.name] ?? p.name}
                        {p.auto ? " (auto)" : ""}
                        {p.ms != null ? ` · ${p.ms} ms` : "…"}
                        {p.ok === false ? " · error" : ""}
                      </span>
                    );
                  if (p.kind === "safety")
                    return (
                      <span key={j} className="my-1 block rounded bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                        Safety rule triggered: {p.rules.join(", ")}
                      </span>
                    );
                  return (
                    <span key={j} role="alert" className="block text-sm text-red-700 dark:text-red-300">
                      {p.message}
                    </span>
                  );
                })}
              </div>
              {m.meta && <p className="mt-1 text-xs text-slate-500">{m.meta}</p>}
            </div>
          ))}
          <div ref={bottom} />
        </div>

        <div className="flex flex-wrap gap-2">
          {TRY_PROMPTS.map((t) => (
            <button
              type="button"
              key={t}
              disabled={busy}
              onClick={() => send(t)}
              className="rounded-full border border-slate-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-slate-700"
            >
              {t}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <label htmlFor="msg" className="sr-only">
            Message
          </label>
          <input
            id="msg"
            className="flex-1 rounded border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message…"
            autoComplete="off"
          />
          <button type="submit" disabled={busy || !input.trim()} className="rounded bg-teal-700 px-4 py-2 text-white disabled:opacity-50">
            Send
          </button>
        </form>
      </section>

      <aside aria-label="Event log" className="space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-800 lg:max-h-[85vh]">
        <h2 className="text-sm font-semibold">Events</h2>
        {conversationId && <p className="text-slate-500">conversation {conversationId.slice(0, 8)}</p>}
        {log.map((e, i) => (
          <details key={i} className="rounded bg-slate-50 p-2 dark:bg-slate-900">
            <summary className="cursor-pointer">
              {e.type}
              {"name" in e ? ` · ${e.name}` : ""}
              {e.type === "tool_result" ? ` · ${e.ms} ms` : ""}
            </summary>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(e, null, 2)}</pre>
          </details>
        ))}
      </aside>
    </main>
  );
}
