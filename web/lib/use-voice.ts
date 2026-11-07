"use client";

import type { PipecatClient } from "@pipecat-ai/client-js";
import { type Dispatch, useCallback, useEffect, useRef, useState } from "react";

import { connectVoice, createVoiceClient, getVoiceConfig } from "./pipecat";
import { type TalkAction, type VoiceLatencyMsg, voiceLatency } from "./talk";

export type VoiceStatus = "idle" | "connecting" | "live" | "ended" | "error";
export type OrbState = "idle" | "listening" | "thinking" | "speaking";

interface Options {
  dispatch: Dispatch<TalkAction>;
  persona: string;
  conversationId: string | null;
}

/** Browser voice call with Pearl (Pipecat client + SmallWebRTC), feeding the shared talk reducer. */
export function useVoice({ dispatch, persona, conversationId }: Options) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<{ message: string; micDenied?: boolean } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(300);
  const [orb, setOrb] = useState<OrbState>("idle");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const client = useRef<PipecatClient | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Levels are written ~20×/s by the client; kept in refs so the orb can read them without re-rendering React.
  const localLevel = useRef(0);
  const remoteLevel = useRef(0);

  useEffect(() => {
    if (status !== "live") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  useEffect(() => () => void client.current?.disconnect(), []);

  const start = useCallback(async () => {
    setError(null);
    setSeconds(0);
    setStatus("connecting");
    try {
      const config = await getVoiceConfig();
      if (config.active_sessions >= config.max_sessions) {
        throw new Error("Pearl is on another call right now. Try again in a minute, or use chat.");
      }
      setMaxSeconds(config.max_session_seconds);
      const c = createVoiceClient(config, {
        onTrackStarted: (track, participant) => {
          // SmallWebRTC reports Pearl's track with NO participant; only the local mic carries local: true.
          if (track.kind !== "audio" || participant?.local === true || !audioRef.current) return;
          audioRef.current.srcObject = new MediaStream([track]);
          audioRef.current.play().then(
            () => setAudioBlocked(false),
            () => setAudioBlocked(true), // autoplay policy: needs one more click
          );
        },
        onLocalAudioLevel: (level) => {
          localLevel.current = level;
        },
        onRemoteAudioLevel: (level) => {
          remoteLevel.current = level;
        },
        onUserTranscript: (d) => dispatch({ type: "user", channel: "voice", text: d.text, final: d.final }),
        onBotOutput: (d) => dispatch({ type: "pearl_segment", text: d.text ?? "", segment: (d as { segment_id?: number }).segment_id }),
        onUserStartedSpeaking: () => setOrb("listening"),
        onUserStoppedSpeaking: () => setOrb("thinking"),
        onBotStartedSpeaking: () => setOrb("speaking"),
        onBotStoppedSpeaking: () => {
          setOrb("listening");
          dispatch({ type: "assistant_done", channel: "voice" });
        },
        onServerMessage: (m: { type?: string } & Record<string, unknown>) => {
          switch (m.type) {
            case "session":
              if (typeof m.conversation_id === "string") dispatch({ type: "conversation", id: m.conversation_id });
              break;
            case "latency":
              dispatch({ type: "latency", row: voiceLatency(m as unknown as VoiceLatencyMsg) });
              break;
            case "tool_call":
              dispatch({ type: "tool_call", channel: "voice", id: String(m.id), name: String(m.name), args: (m.args ?? {}) as Record<string, unknown>, auto: Boolean(m.auto) });
              break;
            case "tool_result":
              dispatch({ type: "tool_result", channel: "voice", id: String(m.id), name: String(m.name), result: (m.result ?? {}) as Record<string, unknown>, ms: Number(m.ms) });
              break;
            case "safety":
              dispatch({ type: "safety", channel: "voice", rules: (m.rules as string[]) ?? [] });
              break;
            case "claim_blocked":
              dispatch({ type: "blocked", text: String(m.text) });
              break;
            case "interruption":
              dispatch({ type: "interrupt" });
              break;
            case "session_ending":
              dispatch({ type: "info", channel: "voice", text: "Demo call time limit reached" });
              break;
          }
        },
        onDisconnected: () => {
          setOrb("idle");
          setStatus((s) => (s === "error" ? s : "ended"));
          dispatch({ type: "assistant_done", channel: "voice" });
        },
        onError: (e) => {
          const data = (e as { data?: { message?: string; fatal?: boolean } }).data;
          const message = String(data?.message ?? "Voice error");
          // Non-fatal errors (e.g. a slow TTS chunk) don't end the call: note them in the Inspector and carry on.
          if (data?.fatal === false) {
            dispatch({ type: "info", channel: "voice", text: `Pipeline warning: ${message}` });
            return;
          }
          setError({ message });
          setStatus("error");
        },
      });
      client.current = c;
      await c.initDevices();
      await connectVoice(c, persona, conversationId);
      setStatus("live");
      setOrb("listening");
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const micDenied = /denied|NotAllowed|Permission/i.test(msg);
      setError({
        message: micDenied ? "Microphone access was blocked. You can allow it in your browser's site settings, or keep going in chat." : msg,
        micDenied,
      });
      setStatus("error");
      setOrb("idle");
      await client.current?.disconnect();
    }
  }, [dispatch, persona, conversationId]);

  const end = useCallback(async () => {
    await client.current?.disconnect();
    client.current = null;
    setOrb("idle");
    setStatus("ended");
  }, []);

  const enableAudio = useCallback(() => {
    audioRef.current?.play().then(() => setAudioBlocked(false), () => setAudioBlocked(true));
  }, []);

  return { status, error, seconds, maxSeconds, orb, audioBlocked, audioRef, localLevel, remoteLevel, start, end, enableAudio };
}
