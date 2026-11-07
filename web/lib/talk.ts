// One conversation, two channels. Chat (SSE) and voice (RTVI) events are normalized into the same transcript,
// Inspector timeline and per-turn latency rows, so switching between voice and chat keeps a single story.

export type Channel = "chat" | "voice";

export type Part =
  | { kind: "text"; text: string; retracted?: boolean; segment?: number }
  | { kind: "tool"; id: string; name: string; auto?: boolean; ms?: number; ok?: boolean }
  | { kind: "notice"; tone: NoticeTone; text: string };

export type NoticeTone = "safety" | "error" | "info";

export interface Message {
  id: string;
  role: "user" | "assistant";
  channel: Channel;
  parts: Part[];
  interim?: boolean; // voice: caption still being recognized
  streaming?: boolean; // chat: tokens still arriving
  logged?: number; // parts already summarized in the timeline (voice turns can pause, e.g. after the filler)
}

export type TimelineKind =
  | "user"
  | "pearl"
  | "tool_call"
  | "tool_result"
  | "safety"
  | "retract"
  | "blocked"
  | "interrupt"
  | "outcome"
  | "error"
  | "info";

export interface TimelineItem {
  id: string;
  at: number; // ms since the conversation started
  kind: TimelineKind;
  channel: Channel;
  title: string;
  detail?: string;
  json?: unknown;
  ms?: number;
  ok?: boolean;
  tool?: string;
}

export interface LatencySegment {
  key: "stt" | "llm" | "tts" | "tools" | "rest";
  label: string;
  ms: number;
}

export interface TurnLatency {
  id: string;
  channel: Channel;
  segments: LatencySegment[];
  total: number | null; // voice: end of speech → audible; chat: request → done
  totalLabel: string;
  answerMs?: number | null;
  tools: number;
  partial?: boolean;
}

export interface TalkState {
  conversationId: string | null;
  startedAt: number;
  messages: Message[];
  timeline: TimelineItem[];
  latencies: TurnLatency[];
  outcome: string | null;
}

export const TOOL_LABEL: Record<string, string> = {
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

export const initialTalk = (): TalkState => ({
  conversationId: null,
  startedAt: Date.now(),
  messages: [],
  timeline: [],
  latencies: [],
  outcome: null,
});

export type TalkAction =
  | { type: "reset" }
  | { type: "conversation"; id: string }
  | { type: "user"; channel: Channel; text: string; final?: boolean }
  | { type: "token"; text: string }
  | { type: "pearl_segment"; text: string; segment?: number }
  | { type: "assistant_start"; channel: Channel }
  | { type: "assistant_done"; channel: Channel }
  | { type: "retract"; reason: string; times: string[] }
  | { type: "tool_call"; channel: Channel; id: string; name: string; args: Record<string, unknown>; auto?: boolean }
  | { type: "tool_result"; channel: Channel; id: string; name: string; result: Record<string, unknown>; ms: number }
  | { type: "safety"; channel: Channel; rules: string[] }
  | { type: "blocked"; text: string }
  | { type: "interrupt" }
  | { type: "error"; channel: Channel; message: string }
  | { type: "info"; channel: Channel; text: string }
  | { type: "latency"; row: TurnLatency };

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

/** What a successful write tool did, for the timeline, the toast and the calendar highlight. */
export function describeOutcome(name: string, result: Record<string, unknown>): string | null {
  if ("error" in result) return null;
  const summary = typeof result.summary === "string" ? result.summary : null;
  if (name === "book_appointment" && result.booked) return `Booked: ${summary ?? "appointment"}`;
  if (name === "reschedule_appointment" && result.rescheduled) return summary ?? "Rescheduled";
  if (name === "cancel_appointment" && result.cancelled) return `Cancelled: ${result.type ?? "appointment"} on ${result.when ?? ""}`.trim();
  if (name === "escalate_to_human" && result.escalated) return `Escalated to the front desk (${result.urgency ?? "routine"})`;
  if (name === "create_patient" && result.created) return `Registered ${result.full_name ?? "new patient"}`;
  return null;
}

function lastAssistant(messages: Message[], channel: Channel): [Message[], Message] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") return [messages.slice(0, -1), last];
  return [messages, { id: uid("m"), role: "assistant", channel, parts: [] }];
}

function withAssistant(state: TalkState, channel: Channel, fn: (m: Message) => Message): TalkState {
  const [rest, msg] = lastAssistant(state.messages, channel);
  return { ...state, messages: [...rest, fn(msg)] };
}

function push(state: TalkState, item: Omit<TimelineItem, "id" | "at">): TimelineItem[] {
  return [...state.timeline, { ...item, id: uid("t"), at: Date.now() - state.startedAt }];
}

const short = (v: unknown, n = 90) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export function talkReducer(state: TalkState, a: TalkAction): TalkState {
  switch (a.type) {
    case "reset":
      return initialTalk();

    case "conversation":
      return { ...state, conversationId: a.id };

    case "user": {
      const text = a.text.trim();
      if (!text) return state;
      const last = state.messages[state.messages.length - 1];
      let messages: Message[];
      // Voice: interim captions are replaced; a second final in the same turn (a pause mid-sentence) is appended.
      if (a.channel === "voice" && last?.role === "user" && last.channel === "voice") {
        const prevText = last.interim ? "" : ((last.parts[0] as { text?: string })?.text ?? "");
        const joined = last.interim ? text : `${prevText} ${text}`;
        messages = [...state.messages.slice(0, -1), { ...last, parts: [{ kind: "text", text: joined }], interim: a.final === false }];
      } else {
        messages = [...state.messages, { id: uid("m"), role: "user", channel: a.channel, parts: [{ kind: "text", text }], interim: a.final === false }];
      }
      const timeline = a.final === false ? state.timeline : push(state, { kind: "user", channel: a.channel, title: text });
      return { ...state, messages, timeline };
    }

    case "assistant_start":
      return { ...state, messages: [...state.messages, { id: uid("m"), role: "assistant", channel: a.channel, parts: [], streaming: true }] };

    case "token":
      return withAssistant(state, "chat", (m) => {
        const parts = [...m.parts];
        const last = parts[parts.length - 1];
        if (last?.kind === "text" && !last.retracted) parts[parts.length - 1] = { ...last, text: last.text + a.text };
        else parts.push({ kind: "text", text: a.text });
        return { ...m, parts, streaming: true };
      });

    case "pearl_segment": {
      if (!a.text.trim()) return state;
      const next = withAssistant(state, "voice", (m) => {
        const parts = [...m.parts];
        const i = a.segment == null ? -1 : parts.findIndex((p) => p.kind === "text" && p.segment === a.segment);
        if (i >= 0) parts[i] = { kind: "text", text: a.text, segment: a.segment };
        else parts.push({ kind: "text", text: a.text, segment: a.segment });
        return { ...m, parts };
      });
      return next;
    }

    case "assistant_done": {
      const [rest, msg] = lastAssistant(state.messages, a.channel);
      if (!msg.parts.length) return { ...state, messages: rest };
      const text = msg.parts
        .slice(msg.logged ?? 0)
        .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text" && !p.retracted)
        .map((p) => p.text)
        .join(" ")
        .trim();
      return {
        ...state,
        messages: [...rest, { ...msg, streaming: false, logged: msg.parts.length }],
        timeline: text ? push(state, { kind: "pearl", channel: a.channel, title: short(text, 140) }) : state.timeline,
      };
    }

    case "retract": {
      const next = withAssistant(state, "chat", (m) => {
        const parts = [...m.parts];
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          if (p.kind === "text" && !p.retracted) {
            parts[i] = { ...p, retracted: true };
            break;
          }
        }
        return { ...m, parts };
      });
      return {
        ...next,
        timeline: push(state, {
          kind: "retract",
          channel: "chat",
          title: "Reply retracted: unverified times",
          detail: `${a.times.join(", ")} didn't come from a tool result. Pearl was told to check availability first.`,
        }),
      };
    }

    case "tool_call": {
      const next = withAssistant(state, a.channel, (m) => ({ ...m, parts: [...m.parts, { kind: "tool", id: a.id, name: a.name, auto: a.auto }] }));
      return {
        ...next,
        timeline: push(state, { kind: "tool_call", channel: a.channel, title: `${a.name}(${short(a.args, 70)})`, detail: a.auto ? "automatic: caller ID" : undefined, json: a.args }),
      };
    }

    case "tool_result": {
      const ok = !("error" in a.result);
      const messages = state.messages.map((m) =>
        m.role !== "assistant" ? m : { ...m, parts: m.parts.map((p) => (p.kind === "tool" && p.id === a.id ? { ...p, ms: a.ms, ok } : p)) },
      );
      let timeline = push(state, {
        kind: "tool_result",
        channel: a.channel,
        title: `${a.name} → ${ok ? "ok" : String(a.result.error)}`,
        json: a.result,
        tool: a.name,
        ms: a.ms,
        ok,
      });
      const outcome = describeOutcome(a.name, a.result);
      if (outcome) timeline = [...timeline, { id: uid("t"), at: Date.now() - state.startedAt, kind: "outcome", channel: a.channel, title: outcome }];
      return { ...state, messages, timeline, outcome: outcome ?? state.outcome };
    }

    case "safety": {
      const next = withAssistant(state, a.channel, (m) => ({
        ...m,
        parts: [...m.parts, { kind: "notice", tone: "safety", text: "Safety rule: this sounds urgent" }],
      }));
      return { ...next, timeline: push(state, { kind: "safety", channel: a.channel, title: `Safety rule: ${a.rules.join(", ")}`, detail: "Detected before the model ran; escalation is guaranteed." }) };
    }

    case "blocked":
      return {
        ...state,
        timeline: push(state, { kind: "blocked", channel: "voice", title: "Blocked an unbacked claim", detail: `"${a.text}" was never said: no booking tool had succeeded.` }),
      };

    case "interrupt":
      return { ...state, timeline: push(state, { kind: "interrupt", channel: "voice", title: "You interrupted Pearl", detail: "She stopped speaking and listened." }) };

    case "error": {
      const next = withAssistant(state, a.channel, (m) => ({ ...m, streaming: false, parts: [...m.parts, { kind: "notice", tone: "error", text: a.message }] }));
      return { ...next, timeline: push(state, { kind: "error", channel: a.channel, title: a.message }) };
    }

    case "info":
      return { ...state, timeline: push(state, { kind: "info", channel: a.channel, title: a.text }) };

    case "latency":
      return { ...state, latencies: [...state.latencies, a.row] };
  }
}

// ── latency normalization ──────────────────────────────────────

export interface VoiceLatencyMsg {
  stt_ms: number | null;
  llm_ttft_ms: number | null;
  tts_ttfb_ms: number | null;
  voice_to_voice_ms: number | null;
  answer_ms: number | null;
  tool_calls: number;
  partial?: boolean;
}

export function voiceLatency(m: VoiceLatencyMsg): TurnLatency {
  const segs: LatencySegment[] = [];
  if (m.stt_ms != null) segs.push({ key: "stt", label: "Speech to text", ms: m.stt_ms });
  if (m.llm_ttft_ms != null) segs.push({ key: "llm", label: "LLM first token", ms: m.llm_ttft_ms });
  if (m.tts_ttfb_ms != null) segs.push({ key: "tts", label: "TTS first byte", ms: m.tts_ttfb_ms });
  const total = m.voice_to_voice_ms;
  const known = segs.reduce((s, x) => s + x.ms, 0);
  if (total != null && total > known + 20) segs.push({ key: "rest", label: "Turn handling + transport", ms: total - known });
  return {
    id: uid("l"),
    channel: "voice",
    segments: segs,
    total,
    totalLabel: m.tool_calls ? "first audio (filler)" : "voice to voice",
    answerMs: m.answer_ms,
    tools: m.tool_calls,
    partial: m.partial,
  };
}

export function chatLatency(t: { total_ms?: number; ttft_ms?: number | null; llm_ms?: number; tools_ms?: number }, tools: number): TurnLatency {
  const segs: LatencySegment[] = [];
  if (t.ttft_ms != null) segs.push({ key: "llm", label: "LLM first token", ms: t.ttft_ms });
  if (t.tools_ms) segs.push({ key: "tools", label: "Tools", ms: t.tools_ms });
  const known = segs.reduce((s, x) => s + x.ms, 0);
  if (t.total_ms != null && t.total_ms > known + 20) segs.push({ key: "rest", label: "Generating", ms: t.total_ms - known });
  return { id: uid("l"), channel: "chat", segments: segs, total: t.total_ms ?? null, totalLabel: "full reply", tools };
}
