"use client";

import { type Dispatch, useCallback, useEffect, useRef, useState } from "react";

import { BrowserTTS, isHandheld } from "./browser-tts";
import { streamChat } from "./chat";
import { AGENT_URL } from "./config";
import { type TalkAction, voiceLatency } from "./talk";
import type { OrbState, VoiceStatus } from "./use-voice";
import { ChunkSplitter, forSpeech } from "./voice-text";

// Serverless voice: everything audio happens in the browser. VAD (Silero, in the browser) finds the end of each
// utterance → /api/transcribe (Groq Whisper) → /api/chat streams Pearl's reply → spoken by Kokoro in a Web Worker.
// Same return shape as useVoice (Pipecat), so the Talk page can use either.
//
// Turn-taking rules (so a request is never lost):
// - Speech while Pearl talks only DUCKS her volume; she stops once it is confirmed as real words (not noise, not an
//   echo of her own voice).
// - A new request never cancels the one in flight: that reply is silenced but still completes and is saved on the
//   server, then the new request goes out (turns are strictly sequential).

const VAD_ASSETS = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/";
const ORT_ASSETS = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
const GREETING = "Hi, this is Pearl at Pearl Dental Care. How can I help you today?";
const RESUME_GREETING = "Hi, it's Pearl. I have our chat in front of me, so go ahead.";
const FILLER = "One moment, let me check.";
const WRITE_TOOLS = new Set(["book_appointment", "reschedule_appointment", "cancel_appointment"]);
const REDEMPTION_MS = 600;
const VAD_NORMAL = { positiveSpeechThreshold: 0.6, negativeSpeechThreshold: 0.45, minSpeechMs: 250 };
const VAD_WHILE_PEARL_SPEAKS = { positiveSpeechThreshold: 0.8, negativeSpeechThreshold: 0.6, minSpeechMs: 400 };
// Whisper invents these on breaths, clicks and silence.
const NOISE = /^(you|thank you\.?|thanks\.?|thanks for watching\.?|bye\.?|okay\.?|\.+|[\s.,!?-]*)$/i;

interface Options {
  dispatch: Dispatch<TalkAction>;
  persona: string;
  conversationId: string | null;
}

type VAD = {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  destroy: () => Promise<void>;
  setOptions: (o: Partial<typeof VAD_NORMAL>) => void;
};

interface Turn {
  index: number;
  silenced: boolean;
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/** Is this transcript just Pearl's own voice picked up by the microphone? */
export function isEcho(heard: string, recentlySaid: string[]): boolean {
  const w = words(heard);
  if (!w.length) return true;
  const said = new Set(recentlySaid.flatMap(words));
  return w.filter((x) => said.has(x)).length / w.length >= 0.7;
}

/** Warm the VAD code and model before the call starts (e.g. while the mic explainer is showing). */
export function prewarmBrowserVoice() {
  void import("@ricky0123/vad-web").catch(() => {});
  for (const url of [`${VAD_ASSETS}silero_vad_v5.onnx`, `${VAD_ASSETS}vad.worklet.bundle.min.js`, `${ORT_ASSETS}ort-wasm-simd-threaded.wasm`])
    void fetch(url, { mode: "cors" }).catch(() => {});
}

export function useBrowserVoice({ dispatch, persona, conversationId }: Options) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<{ message: string; micDenied?: boolean } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(240);
  const [orb, setOrb] = useState<OrbState>("idle");
  const [engine, setEngine] = useState<string>("");
  const [waiting, setWaiting] = useState(false); // a request is being worked on and Pearl isn't talking yet
  const [audioBlocked, setAudioBlocked] = useState(false); // the browser is keeping Pearl silent
  const audioRef = useRef<HTMLAudioElement | null>(null); // unused here (Web Audio), kept for a shared interface
  const localLevel = useRef(0);
  const remoteLevel = useRef(0);

  const vad = useRef<VAD | null>(null);
  const tts = useRef<BrowserTTS | null>(null);
  const convId = useRef<string | null>(conversationId);
  const hangup = useRef<AbortController | null>(null);
  const current = useRef<Turn | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0); // utterances transcribed or queued but not answered yet
  const turnIndex = useRef(0);
  const lastWriteTurn = useRef(-10);
  const segment = useRef(1);
  const recentlySaid = useRef<{ text: string; at: number }[]>([]);
  const levelTimer = useRef<number | null>(null);

  useEffect(() => {
    convId.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    if (status !== "live") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  const teardown = useCallback(async () => {
    hangup.current?.abort();
    hangup.current = null;
    current.current = null;
    chain.current = Promise.resolve();
    pending.current = 0;
    setWaiting(false);
    if (levelTimer.current) cancelAnimationFrame(levelTimer.current);
    levelTimer.current = null;
    try {
      await vad.current?.destroy();
    } catch {
      /* already gone */
    }
    vad.current = null;
    tts.current?.close();
    tts.current = null;
    localLevel.current = 0;
    remoteLevel.current = 0;
  }, []);

  useEffect(() => () => void teardown(), [teardown]);

  const say = useCallback(
    (text: string, opts: { caption?: boolean } = {}) => {
      const { text: spoken, blocked } = forSpeech(text, lastWriteTurn.current >= turnIndex.current - 1);
      if (blocked) dispatch({ type: "blocked", text });
      if (opts.caption !== false) dispatch({ type: "pearl_segment", text: blocked ? spoken : text, segment: segment.current++ });
      const now = Date.now();
      recentlySaid.current = [...recentlySaid.current.filter((r) => now - r.at < 20_000), { text: spoken, at: now }];
      tts.current?.speak(spoken);
    },
    [dispatch],
  );

  /** One request → Pearl's reply. Runs strictly one at a time (see `chain`). */
  const runTurn = useCallback(
    async (text: string, tEnd: number, sttMs: number) => {
      const me: Turn = { index: ++turnIndex.current, silenced: false };
      current.current = me;
      setWaiting(true);
      setOrb("thinking");
      const splitter = new ChunkSplitter();
      let spokeAny = false;
      let fillerDone = false;
      let tools = 0;
      let firstToken: number | null = null;
      let firstChunkAt: number | null = null;
      const emit = (chunk: string) => {
        if (me.silenced) {
          dispatch({ type: "pearl_segment", text: chunk, segment: segment.current++ }); // keep the transcript whole
          return;
        }
        if (firstChunkAt === null) firstChunkAt = performance.now();
        spokeAny = true;
        setWaiting(false);
        say(chunk);
      };
      const tChat = performance.now();
      try {
        await streamChat(
          { message: text, conversation_id: convId.current, persona, channel: "voice" },
          (e) => {
            switch (e.type) {
              case "conversation":
                convId.current = e.conversation_id;
                dispatch({ type: "conversation", id: e.conversation_id });
                break;
              case "token":
                if (firstToken === null) firstToken = performance.now();
                splitter.push(e.text).forEach(emit);
                break;
              case "retract":
                // Spoken words can't be unsaid; drop what's queued and let the correction follow.
                if (!me.silenced) tts.current?.stop();
                splitter.flush();
                dispatch({ type: "info", channel: "voice", text: "Pearl corrected herself: she named a time no tool had returned" });
                break;
              case "tool_call":
                tools += e.auto ? 0 : 1;
                dispatch({ type: "tool_call", channel: "voice", id: e.id, name: e.name, args: e.args, auto: e.auto });
                if (!e.auto && !spokeAny && !fillerDone) {
                  fillerDone = true;
                  emit(FILLER);
                  setWaiting(true); // she said "one moment": keep showing that she's working on it
                }
                break;
              case "tool_result":
                if (WRITE_TOOLS.has(e.name) && !("error" in e.result)) lastWriteTurn.current = me.index;
                dispatch({ type: "tool_result", channel: "voice", id: e.id, name: e.name, result: e.result, ms: e.ms });
                break;
              case "safety":
                dispatch({ type: "safety", channel: "voice", rules: e.rules });
                break;
              case "error":
                dispatch({ type: "error", channel: "voice", message: e.message });
                emit("Sorry, I'm having trouble right now. Could you try again in a moment?");
                break;
              case "done": {
                const rest = splitter.flush();
                if (rest) emit(rest);
                break;
              }
            }
          },
          hangup.current?.signal,
        );
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          dispatch({ type: "error", channel: "voice", message: (e as Error).message });
          emit("Sorry, I lost the connection for a moment. Could you say that again?");
        }
      }
      if (current.current === me) setWaiting(false);
      if (me.silenced || !spokeAny) {
        if (!me.silenced) setOrb("listening");
        dispatch({ type: "latency", row: voiceLatency({ stt_ms: sttMs, llm_ttft_ms: null, tts_ttfb_ms: null, voice_to_voice_ms: null, answer_ms: null, tool_calls: tools, partial: true }) });
        return;
      }
      // First audible output may still be pending (synthesis queue): wait briefly for it.
      const audibleAfter = (t: number) => (tts.current && tts.current.startedAt >= t ? tts.current.startedAt : null);
      const t0 = Date.now();
      while (firstChunkAt !== null && audibleAfter(firstChunkAt) === null && Date.now() - t0 < 15000 && !me.silenced)
        await new Promise((r) => setTimeout(r, 50));
      const audible = firstChunkAt !== null ? audibleAfter(firstChunkAt) : null;
      dispatch({
        type: "latency",
        row: voiceLatency({
          stt_ms: sttMs,
          llm_ttft_ms: firstToken !== null ? Math.round(firstToken - tChat) : null,
          tts_ttfb_ms: firstChunkAt !== null && audible !== null ? Math.max(0, Math.round(audible - firstChunkAt)) : null,
          voice_to_voice_ms: audible !== null ? Math.round(audible - tEnd + REDEMPTION_MS) : null,
          answer_ms: null,
          tool_calls: tools,
          partial: me.silenced,
        }),
      });
    },
    [dispatch, persona, say],
  );

  const handleUtterance = useCallback(
    async (audio: Float32Array) => {
      const tEnd = performance.now();
      pending.current++;
      if (!tts.current?.speaking) setOrb("thinking");
      const { utils } = await import("@ricky0123/vad-web");
      const form = new FormData();
      form.append("audio", new Blob([utils.encodeWAV(audio)], { type: "audio/wav" }), "utterance.wav");
      let text = "";
      const tStt = performance.now();
      try {
        const res = await fetch(`${AGENT_URL}/api/transcribe`, { method: "POST", body: form, signal: hangup.current?.signal });
        const data = (await res.json()) as { text?: string; detail?: string };
        if (!res.ok) throw new Error(data.detail ?? `Transcription failed (${res.status})`);
        text = (data.text ?? "").trim();
      } catch (e) {
        pending.current--;
        if ((e as Error).name === "AbortError") return;
        dispatch({ type: "info", channel: "voice", text: `Didn't catch that: ${(e as Error).message}` });
        tts.current?.duck(1);
        if (!current.current && !tts.current?.speaking) setOrb("listening");
        return;
      }
      const sttMs = Math.round(performance.now() - tStt);
      const pearlTalking = Boolean(tts.current?.speaking);
      const recent = recentlySaid.current.filter((r) => Date.now() - r.at < 20_000).map((r) => r.text);
      // Noise, or Pearl hearing herself: ignore it and let her carry on at full volume.
      if (NOISE.test(text) || (pearlTalking && isEcho(text, recent))) {
        pending.current--;
        tts.current?.duck(1);
        if (!current.current && !tts.current?.speaking) setOrb("listening");
        return;
      }
      // Real words: this is the caller talking. Silence Pearl (barge-in) and queue the request.
      if (pearlTalking) {
        dispatch({ type: "interrupt" });
        tts.current?.stop();
      }
      if (current.current) current.current.silenced = true; // its reply still completes and is saved, unspoken
      dispatch({ type: "user", channel: "voice", text, final: true });
      setWaiting(true);
      setOrb("thinking");
      const next = chain.current.then(() => runTurn(text, tEnd, sttMs));
      chain.current = next.catch(() => {});
      await next.finally(() => {
        pending.current--;
      });
    },
    [dispatch, runTurn],
  );

  const start = useCallback(async () => {
    setError(null);
    setSeconds(0);
    setStatus("connecting");
    setAudioBlocked(false);
    hangup.current = new AbortController();
    try {
      // Create and unlock the audio player FIRST, synchronously inside the tap: phones (iOS Safari especially) keep
      // audio silent if it's first started after an `await`.
      const t = new BrowserTTS({
        onBlocked: () => setAudioBlocked(true),
        onSpeakStart: () => {
          setOrb("speaking");
          vad.current?.setOptions(VAD_WHILE_PEARL_SPEAKS); // harder to trigger on her own echo
        },
        onIdle: () => {
          vad.current?.setOptions(VAD_NORMAL);
          setOrb(current.current && pending.current > 0 ? "thinking" : "listening");
          dispatch({ type: "assistant_done", channel: "voice" });
        },
        onStatus: (s, detail) =>
          setEngine(
            s === "loading"
              ? "Loading Pearl's voice (first call downloads ~90 MB)…"
              : s === "kokoro"
                ? `Voice: Kokoro in your browser (${detail})`
                : "Voice: your browser's built-in voice",
          ),
      });
      tts.current = t;
      t.unlock();

      const cfg = (await (await fetch(`${AGENT_URL}/api/voice/config`, { cache: "no-store" })).json()) as {
        daily_limit_reached?: boolean;
        resting_message?: string;
        max_session_seconds?: number;
      };
      if (cfg.daily_limit_reached) throw new Error(cfg.resting_message ?? "Pearl is resting for today. Chat still works!");
      setMaxSeconds(cfg.max_session_seconds ?? 240);
      // Greet right away (browser voice until Kokoro is ready) while the microphone pipeline loads.
      say(convId.current ? RESUME_GREETING : GREETING);

      const { MicVAD } = await import("@ricky0123/vad-web");
      const v = await MicVAD.new({
        model: "v5",
        baseAssetPath: VAD_ASSETS,
        onnxWASMBasePath: ORT_ASSETS,
        ...VAD_NORMAL,
        redemptionMs: REDEMPTION_MS,
        preSpeechPadMs: 300,
        getStream: () =>
          navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          }),
        onSpeechStart: () => {
          // Maybe the caller, maybe Pearl's echo: lower her volume until the words are known.
          if (tts.current?.speaking) tts.current.duck(0.25);
          else if (!current.current) setOrb("listening");
        },
        onVADMisfire: () => tts.current?.duck(1),
        onSpeechEnd: (audio: Float32Array) => void handleUtterance(audio),
        onFrameProcessed: (_p: unknown, frame: Float32Array) => {
          let sum = 0;
          for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
          localLevel.current = Math.min(1, Math.sqrt(sum / frame.length) * 8);
        },
      });
      vad.current = v as unknown as VAD;
      await v.start();
      void t.resume().catch(() => setAudioBlocked(true)); // iOS interrupts playback when the mic starts
      if (t.speaking) vad.current.setOptions(VAD_WHILE_PEARL_SPEAKS);
      // Phones keep the built-in voice for the whole call (Kokoro is too heavy there); desktops load Kokoro now.
      if (isHandheld()) setEngine("Voice: your phone's built-in voice");
      else t.startKokoro();

      const tick = () => {
        remoteLevel.current = tts.current?.level() ?? 0;
        levelTimer.current = requestAnimationFrame(tick);
      };
      tick();

      setStatus("live");
      if (!t.speaking) setOrb("listening");
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const micDenied = /denied|NotAllowed|Permission/i.test(msg);
      setError({
        message: micDenied ? "Microphone access was blocked. You can allow it in your browser's site settings, or keep going in chat." : msg,
        micDenied,
      });
      setStatus("error");
      setOrb("idle");
      await teardown();
    }
  }, [dispatch, handleUtterance, say, teardown]);

  const end = useCallback(async () => {
    await teardown();
    setOrb("idle");
    setStatus("ended");
  }, [teardown]);

  // Demo time limit: one timer per call.
  useEffect(() => {
    if (status !== "live") return;
    const t = setTimeout(() => {
      dispatch({ type: "info", channel: "voice", text: "Demo call time limit reached" });
      void end();
    }, maxSeconds * 1000);
    return () => clearTimeout(t);
  }, [status, maxSeconds, dispatch, end]);

  // The "enable sound" button: a fresh tap, so unlocking works this time.
  const enableAudio = useCallback(() => {
    tts.current?.unlock();
    setAudioBlocked(false);
  }, []);

  return { status, error, seconds, maxSeconds, orb, audioBlocked, audioRef, localLevel, remoteLevel, start, end, enableAudio, engine, waiting };
}
