"use client";

import type { PipecatClient } from "@pipecat-ai/client-js";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { PERSONAS } from "@/lib/personas";
import { connectVoice, createVoiceClient, getVoiceConfig } from "@/lib/pipecat";

// M3: minimal voice harness. The designed orb + Inspector experience arrives in M4.

type Status = "idle" | "explain" | "connecting" | "live" | "ended" | "error";

interface Line {
  who: "you" | "pearl" | "event";
  text: string;
  final?: boolean;
  segment?: number;
}

interface Latency {
  stt_ms: number | null;
  llm_ttft_ms: number | null;
  tts_ttfb_ms: number | null;
  voice_to_voice_ms: number | null;
  answer_ms: number | null;
  filler_first: boolean;
  tool_calls: number;
  vad_stop_ms: number;
  partial?: boolean;
}

const fmt = (v: number | null | undefined) => (v == null ? "—" : `${v}`);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export default function VoicePage() {
  const [persona, setPersona] = useState("ravi");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [latencies, setLatencies] = useState<Latency[]>([]);
  const [seconds, setSeconds] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(300);
  const [speaking, setSpeaking] = useState<"you" | "pearl" | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const client = useRef<PipecatClient | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (status !== "live") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  useEffect(() => () => void client.current?.disconnect(), []);

  function push(line: Line) {
    setLines((ls) => {
      // bot-output is a progress stream: one segment (sentence) arrives as new → in-progress → completed.
      if (line.segment != null) {
        const i = ls.findIndex((l) => l.who === "pearl" && l.segment === line.segment);
        if (i >= 0) return [...ls.slice(0, i), line, ...ls.slice(i + 1)];
      }
      const last = ls[ls.length - 1];
      // replace interim user captions with the newer interim/final text
      if (line.who === "you" && last?.who === "you" && last.final === false) return [...ls.slice(0, -1), line];
      return [...ls, line];
    });
  }

  async function start() {
    setError(null);
    setLines([]);
    setLatencies([]);
    setSeconds(0);
    setStatus("connecting");
    try {
      const config = await getVoiceConfig();
      if (config.active_sessions >= config.max_sessions) throw new Error("Pearl is on another call right now. Try again in a minute, or use chat.");
      setMaxSeconds(config.max_session_seconds);
      const c = createVoiceClient(config, {
        onTrackStarted: (track, participant) => {
          // SmallWebRTC reports Pearl's track with NO participant; only the local mic carries local: true.
          if (track.kind !== "audio" || participant?.local === true || !audio.current) return;
          audio.current.srcObject = new MediaStream([track]);
          audio.current.play().then(
            () => setAudioBlocked(false),
            () => setAudioBlocked(true), // autoplay policy: needs one more click
          );
        },
        onUserTranscript: (d) => push({ who: "you", text: d.text, final: d.final }),
        onBotOutput: (d) => {
          if (d.text?.trim()) push({ who: "pearl", text: d.text, segment: d.segment_id });
        },
        onUserStartedSpeaking: () => setSpeaking("you"),
        onUserStoppedSpeaking: () => setSpeaking(null),
        onBotStartedSpeaking: () => setSpeaking("pearl"),
        onBotStoppedSpeaking: () => setSpeaking(null),
        onServerMessage: (m: { type?: string } & Record<string, unknown>) => {
          if (m.type === "latency") setLatencies((ls) => [...ls, m as unknown as Latency]);
          else if (m.type === "tool_call") push({ who: "event", text: `🔧 ${m.name}${m.auto ? " (auto)" : ""}(${JSON.stringify(m.args)})` });
          else if (m.type === "tool_result") push({ who: "event", text: `📦 ${m.name} · ${m.ms} ms${(m.result as Record<string, unknown>)?.error ? " · error" : ""}` });
          else if (m.type === "safety") push({ who: "event", text: `🛡 safety rule triggered: ${(m.rules as string[]).join(", ")}` });
          else if (m.type === "claim_blocked") push({ who: "event", text: `🛑 blocked an unbacked claim: "${m.text}"` });
          else if (m.type === "interruption") push({ who: "event", text: "✋ you interrupted Pearl" });
          else if (m.type === "session_ending") push({ who: "event", text: "⏱ session time limit reached" });
        },
        onDisconnected: () => setStatus((s) => (s === "error" ? s : "ended")),
        onError: (e) => {
          setError(String((e as { data?: { message?: string } }).data?.message ?? "Voice error"));
          setStatus("error");
        },
      });
      client.current = c;
      await c.initDevices();
      await connectVoice(c, persona);
      setStatus("live");
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const denied = /denied|NotAllowed|Permission/i.test(msg);
      setError(denied ? "Microphone access was blocked. You can allow it in the browser's site settings, or use chat instead." : msg);
      setStatus("error");
      await client.current?.disconnect();
    }
  }

  async function end() {
    await client.current?.disconnect();
    setStatus("ended");
  }

  const answered = latencies.filter((l) => !l.partial);
  const simple = answered.filter((l) => !l.tool_calls).map((l) => l.voice_to_voice_ms ?? 0);

  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-[1fr_420px]">
      <section className="flex flex-col gap-4">
        <header className="flex flex-wrap items-center gap-3">
          <Link href="/" className="text-sm underline">
            ← Status
          </Link>
          <h1 className="text-2xl font-semibold">Talk to Pearl</h1>
          <Link href="/chat" className="text-sm underline">
            Prefer to chat?
          </Link>
          <label className="ml-auto flex items-center gap-2 text-sm">
            I am
            <select
              className="rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700"
              value={persona}
              disabled={status === "live" || status === "connecting"}
              onChange={(e) => setPersona(e.target.value)}
            >
              {PERSONAS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.description})
                </option>
              ))}
            </select>
          </label>
        </header>

        <div className="flex flex-wrap items-center gap-3">
          {(status === "idle" || status === "ended" || status === "error") && (
            <button type="button" className="rounded bg-teal-700 px-4 py-2 font-medium text-white" onClick={() => setStatus("explain")}>
              🎙 {status === "idle" ? "Start call" : "Call again"}
            </button>
          )}
          {status === "connecting" && <p aria-busy="true">Connecting…</p>}
          {status === "live" && (
            <>
              <button type="button" className="rounded bg-red-700 px-4 py-2 font-medium text-white" onClick={end}>
                End call
              </button>
              <span className="tabular-nums text-sm text-slate-600 dark:text-slate-300" aria-label="Call timer">
                {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} / {Math.floor(maxSeconds / 60)}:00
              </span>
              <span className="text-sm" aria-live="polite">
                {speaking === "you" ? "Listening…" : speaking === "pearl" ? "Pearl is speaking" : "…"}
              </span>
            </>
          )}
        </div>

        {status === "explain" && (
          <div className="rounded-lg border border-teal-600 p-4">
            <p className="mb-3">
              Your browser will ask for microphone access. Audio goes only to the SmileDesk server running on this machine; nothing is recorded.
              Speak naturally: you can interrupt Pearl at any time.
            </p>
            <div className="flex gap-2">
              <button type="button" className="rounded bg-teal-700 px-4 py-2 text-white" onClick={start}>
                Allow mic and call
              </button>
              <button type="button" className="rounded border px-4 py-2" onClick={() => setStatus("idle")}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {audioBlocked && (
          <button
            type="button"
            className="rounded bg-amber-600 px-4 py-2 font-medium text-white"
            onClick={() => audio.current?.play().then(() => setAudioBlocked(false))}
          >
            🔊 Your browser paused Pearl&apos;s audio. Click to enable sound
          </button>
        )}

        {error && (
          <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
            {error}{" "}
            <Link href="/chat" className="underline">
              Switch to chat
            </Link>
          </p>
        )}

        <div className="min-h-[50vh] space-y-2 rounded-lg border border-slate-200 p-4 dark:border-slate-800" aria-live="polite" aria-label="Captions">
          {lines.length === 0 && <p className="text-slate-500">Captions appear here.</p>}
          {lines.map((l, i) =>
            l.who === "event" ? (
              <p key={i} className="font-mono text-xs text-slate-500">
                {l.text}
              </p>
            ) : (
              <p key={i} className={l.who === "you" ? "text-right" : ""}>
                <span className={`inline-block rounded-lg px-3 py-1 ${l.who === "you" ? "bg-teal-700 text-white" : "bg-slate-100 dark:bg-slate-800"} ${l.final === false ? "opacity-60" : ""}`}>
                  {l.text}
                </span>
              </p>
            ),
          )}
        </div>
        <audio ref={audio} autoPlay />
      </section>

      <aside aria-label="Latency" className="space-y-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
        <h2 className="font-semibold">Latency per turn (ms)</h2>
        <p className="text-xs text-slate-500">
          Measured from the moment the server confirms you stopped speaking (plus a {latencies[0]?.vad_stop_ms ?? 500} ms silence window).
          &quot;Audible&quot; may be the &quot;one moment&quot; filler on tool turns; &quot;answer&quot; is when the real answer starts.
        </p>
        <table className="w-full text-right text-xs tabular-nums">
          <thead>
            <tr className="text-slate-500">
              <th className="text-left">#</th>
              <th>STT</th>
              <th>LLM 1st tok</th>
              <th>TTS 1st byte</th>
              <th>audible</th>
              <th>answer</th>
              <th>tools</th>
            </tr>
          </thead>
          <tbody>
            {latencies.map((l, i) => (
              <tr key={i} className={l.partial ? "text-slate-400" : ""}>
                <td className="text-left">{i + 1}</td>
                <td>{fmt(l.stt_ms)}</td>
                <td>{fmt(l.llm_ttft_ms)}</td>
                <td>{fmt(l.tts_ttfb_ms)}</td>
                <td>{l.partial ? "cut off" : fmt(l.voice_to_voice_ms)}</td>
                <td>{fmt(l.answer_ms)}</td>
                <td>{l.tool_calls}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {answered.length > 0 && (
          <p>
            Median audible: <strong>{median(answered.map((l) => l.voice_to_voice_ms ?? 0))} ms</strong>
            {simple.length > 0 && (
              <>
                {" "}
                · without tools: <strong>{median(simple)} ms</strong>
              </>
            )}
          </p>
        )}
      </aside>
    </main>
  );
}
