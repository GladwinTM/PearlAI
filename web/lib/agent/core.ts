import "server-only";

import { APIConnectionError, APIError } from "openai";

import { loadClinic } from "./clinic";
import { settings } from "./config";
import { db, rows } from "./db";
import { spokenTimes, timesIn, ungrounded } from "./grounding";
import { llm } from "./llm";
import { callerPhoneFor } from "./personas";
import { render } from "./prompts";
import { checkMessage } from "./safety";
import { assistantTextBeforeLastUser, executeTool, phonesInText, TOOL_SCHEMAS, ToolContext, type ToolState } from "./tools";

// The tool-calling turn loop (port of agent/core.py), for serverless: state is loaded from and saved to the
// conversations row on every turn, because no memory survives between requests.
//
// Events (Server-Sent Events, same as the Python agent):
//   conversation {conversation_id, persona, prompt_version} · safety {rules, instruction} · token {text}
//   tool_call {id, name, args, auto?} · tool_result {id, name, result, ms} · retract {text, reason, times}
//   done {text, outcome, tools_called, timings} · error {message}

export const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY_MESSAGES = 40;

const ANNOUNCED_ACTION =
  /\b(let me|i'll|i will|i'm going to|allow me to|i am going to)\s+(quickly\s+)?(check|look|see|find|search|book|confirm)|\bone moment\b|\bjust a moment\b|\bplease hold\b|\bchecking (now|that|availability)\b/i;
const NUDGE = "[Clinic system note, not from the patient: you said you would check. Call the right tool now instead of replying.]";
export const FACT_QUESTION =
  /\b(insurance|insured|insurer|price|prices|pricing|cost|costs|how much|fee|fees|charges?|payment|pay (by|with|in)|cards?|upi|cash|emi|parking|park\b|address|located|location|directions|where (are|is) (you|the clinic)|opening hours|what time do you (open|close)|are you open|policy|policies|aftercare|invisalign|aligners?)\b/i;
const NUDGE_FACTS =
  "[Clinic system note, not from the patient: that is a question about the clinic. Call get_clinic_info with it now and answer only from what it returns.]";
const nudgeUngrounded = (times: Set<string>) =>
  `[Clinic system note, not from the patient: you mentioned ${[...times].sort().join(", ")}, which no tool returned. ` +
  "Call check_availability now and only offer times it returns. Do not apologise at length.]";

export type AgentEvent = Record<string, unknown> & { type: string };

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** The model, behind an interface so tests can script it. */
export interface ChatLLM {
  stream(messages: ChatMessage[], toolChoice: "auto" | "none"): AsyncIterable<{ text: string } | { toolCalls: ToolCall[] }>;
}

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

/** Drops <think>…</think> blocks if a model emits reasoning inline. */
export class ThinkFilter {
  private buf = "";
  private inside = false;
  feed(s: string): string {
    this.buf += s;
    let out = "";
    while (this.buf) {
      if (this.inside) {
        const end = this.buf.indexOf("</think>");
        if (end < 0) {
          this.buf = this.buf.slice(-8);
          return out;
        }
        this.buf = this.buf.slice(end + 8);
        this.inside = false;
      } else {
        const start = this.buf.indexOf("<think>");
        if (start < 0) {
          let keep = 0;
          for (let k = Math.min(7, this.buf.length); k > 0; k--)
            if ("<think>".startsWith(this.buf.slice(-k))) {
              keep = k;
              break;
            }
          out += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + 7);
        this.inside = true;
      }
    }
    return out;
  }
  flush(): string {
    const out = this.inside ? "" : this.buf;
    this.buf = "";
    return out;
  }
}

export class OpenAIChatLLM implements ChatLLM {
  async *stream(messages: ChatMessage[], toolChoice: "auto" | "none") {
    const s = settings();
    const params = {
      model: s.llmModel,
      messages,
      tools: TOOL_SCHEMAS,
      tool_choice: toolChoice,
      temperature: s.llmTemperature,
      stream: true as const,
      ...(s.llmReasoningEffort ? { reasoning_effort: s.llmReasoningEffort } : {}),
    };
    let stream: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider-specific fields (reasoning_effort values)
      stream = await llm().chat.completions.create(params as any);
    } catch (e) {
      // Groq validates tool arguments server-side and rejects e.g. {"patient_id": null} for an optional field, but it
      // returns what the model meant to call. Run that (null arguments are dropped by executeTool).
      const recovered = recoverFailedToolCall(e);
      if (!recovered) throw e;
      console.info(`recovered a tool call the provider rejected: ${recovered.name}`);
      yield { toolCalls: [recovered] };
      return;
    }
    const acc = new Map<number, ToolCall>();
    const think = new ThinkFilter();
    for await (const chunk of stream as unknown as AsyncIterable<OpenAI_Chunk>) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        const text = think.feed(delta.content);
        if (text) yield { text };
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = acc.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        acc.set(tc.index, slot);
      }
    }
    const rest = think.flush();
    if (rest) yield { text: rest };
    yield {
      toolCalls: [...acc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ id: v.id || `call_${crypto.randomUUID().slice(0, 8)}`, name: v.name, arguments: v.arguments || "{}" })),
    };
  }
}

export function recoverFailedToolCall(e: unknown): ToolCall | null {
  if (!(e instanceof APIError) || e.status !== 400) return null;
  const body = (e.error ?? {}) as { code?: string; failed_generation?: string };
  if (body.code !== "tool_use_failed" || !body.failed_generation) return null;
  try {
    const g = JSON.parse(body.failed_generation) as { name?: string; arguments?: unknown };
    if (!g.name || !TOOL_SCHEMAS.some((t) => t.function.name === g.name)) return null;
    const args = typeof g.arguments === "string" ? g.arguments : JSON.stringify(g.arguments ?? {});
    return { id: `call_${crypto.randomUUID().slice(0, 8)}`, name: g.name, arguments: args };
  } catch {
    return null;
  }
}

interface OpenAI_Chunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

// ── Conversation state (persisted in conversations.agent_state) ─────────────

export interface Conversation {
  id: string | null;
  channel: "chat" | "voice";
  persona: string | null;
  promptVersion: string;
  messages: ChatMessage[];
  ctx: ToolContext;
  callerLookedUp: boolean;
  groundedTimes: Set<string>;
}

interface StoredState {
  messages: ChatMessage[];
  tool: ToolState;
  callerLookedUp: boolean;
  groundedTimes: string[];
  persona: string | null;
}

export function newConversation(id: string | null, persona: string | null, channel: "chat" | "voice", promptVersion: string): Conversation {
  return {
    id,
    channel,
    persona,
    promptVersion,
    messages: [],
    ctx: new ToolContext(id, channel),
    callerLookedUp: false,
    groundedTimes: new Set(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Continue a stored conversation, or create a new one (persona changes start a new conversation). */
export async function loadConversation(
  conversationId: string | null | undefined,
  persona: string | null,
  channel: "chat" | "voice",
): Promise<Conversation> {
  const s = settings();
  if (conversationId && UUID.test(conversationId)) {
    const found = rows<{ id: string; channel: "chat" | "voice"; prompt_version: string | null; agent_state: StoredState | null }>(
      await db().from("conversations").select("id, channel, prompt_version, agent_state").eq("id", conversationId),
    )[0];
    if (found) {
      const st = found.agent_state;
      const conv = newConversation(found.id, st?.persona ?? persona, channel, found.prompt_version || s.promptVersion);
      if (st) {
        conv.messages = st.messages ?? [];
        conv.ctx = ToolContext.fromJSON({ ...st.tool, conversationId: found.id, channel });
        conv.callerLookedUp = Boolean(st.callerLookedUp);
        conv.groundedTimes = new Set(st.groundedTimes ?? []);
      } else {
        // Started elsewhere (e.g. the Python agent): text-only history; the caller is re-identified before writes.
        const msgs = rows<{ role: string; content: string | null }>(
          await db().from("messages").select("role, content").eq("conversation_id", found.id).order("id"),
        );
        conv.messages = msgs
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }));
      }
      return conv;
    }
  }
  const created = rows<{ id: string }>(
    await db().from("conversations").insert({ channel, prompt_version: s.promptVersion, model: s.llmModel }).select("id"),
  )[0];
  return newConversation(created.id, persona, channel, s.promptVersion);
}

async function saveConversation(conv: Conversation): Promise<void> {
  if (!conv.id) return;
  const state: StoredState = {
    messages: conv.messages.slice(-80),
    tool: conv.ctx.toJSON(),
    callerLookedUp: conv.callerLookedUp,
    groundedTimes: [...conv.groundedTimes],
    persona: conv.persona,
  };
  const patch: Record<string, unknown> = { agent_state: state };
  if (conv.ctx.outcome) patch.outcome = conv.ctx.outcome;
  if (conv.ctx.patientId) patch.patient_id = conv.ctx.patientId;
  const res = await db().from("conversations").update(patch).eq("id", conv.id);
  if (res.error) console.warn(`conversation save failed: ${res.error.message}`);
}

// ── The turn loop ───────────────────────────────────────────────

function trim(history: ChatMessage[]): ChatMessage[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history;
  const tail = history.slice(-MAX_HISTORY_MESSAGES);
  const i = tail.findIndex((m) => m.role === "user");
  return i >= 0 ? tail.slice(i) : tail;
}

function parseArgs(raw: string): [Record<string, unknown>, string | null] {
  try {
    let v: unknown = JSON.parse(raw || "{}");
    if (typeof v === "string") v = JSON.parse(v); // some models double-encode
    return v && typeof v === "object" && !Array.isArray(v) ? [v as Record<string, unknown>, null] : [{}, "arguments must be a JSON object"];
  } catch (e) {
    return [{}, `invalid JSON arguments: ${(e as Error).message}`];
  }
}

const callMsg = (call: ToolCall): ChatMessage => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }],
});

export async function* runTurn(conv: Conversation, userText: string, model: ChatLLM = new OpenAIChatLLM()): AsyncGenerator<AgentEvent> {
  const tTurn = performance.now();
  const timings: Record<string, unknown> & { llm_calls: Record<string, unknown>[]; tools_ms: number; ttft_ms: number | null } = {
    llm_calls: [],
    tools_ms: 0,
    ttft_ms: null,
    rounds: 0,
  };
  const logs: Record<string, unknown>[] = [];

  const safety = checkMessage(userText);
  if (safety.triggered) yield { type: "safety", rules: safety.rules, instruction: safety.instruction };

  conv.messages.push({ role: "user", content: userText });
  conv.ctx.lastAssistantText = assistantTextBeforeLastUser(conv.messages);
  phonesInText(userText).forEach((p) => conv.ctx.allowedPhones.add(p));
  spokenTimes(userText).forEach((t) => conv.groundedTimes.add(t)); // echoing the caller's own time is fine
  const callerPhone = callerPhoneFor(conv.persona);
  if (callerPhone) conv.ctx.allowedPhones.add(callerPhone);
  const userMsg = conv.messages[conv.messages.length - 1];
  logs.push({ role: "user", content: userText });

  const clinic = await loadClinic();
  const system = render(conv.promptVersion, clinic, new Date());
  const called: string[] = [];
  const spoken: string[] = [];
  let nudged = false;
  let finalText = "";
  const outcomeBefore = conv.ctx.outcome;

  const notes: string[] = []; // clinic-system notes attached to this user turn
  let lastResult: Record<string, unknown> | null = null;
  const runTool = async function* (call: ToolCall, auto = false): AsyncGenerator<AgentEvent> {
    const [args, parseError] = parseArgs(call.arguments);
    yield { type: "tool_call", id: call.id, name: call.name, args, ...(auto ? { auto: true } : {}) };
    const [result, ms] = parseError
      ? [{ error: parseError, hint: "Call the tool again with valid JSON arguments." }, 0]
      : await executeTool(call.name, args, conv.ctx);
    timings.tools_ms += ms;
    called.push(call.name);
    timesIn(result).forEach((t) => conv.groundedTimes.add(t));
    lastResult = result;
    yield { type: "tool_result", id: call.id, name: call.name, result, ms };
    conv.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    logs.push({ role: "tool", tool_name: call.name, tool_args: args, tool_result: result, latency_ms: ms });
  };

  try {
    // Caller ID: like a real front-desk system, look the number up before the model even speaks.
    if (callerPhone && !conv.callerLookedUp) {
      conv.callerLookedUp = true;
      const call = { id: `auto_${crypto.randomUUID().slice(0, 8)}`, name: "lookup_patient", arguments: JSON.stringify({ phone: callerPhone }) };
      conv.messages.push(callMsg(call));
      yield* runTool(call, true);
      // Known caller: greet by name now; the number is confirmed in the booking question (enforced by
      // book_appointment's guard via ctx.confirmNumber), not at the start of the call.
      const found = lastResult as { found?: boolean; number_ending?: string; patients?: { full_name: string }[] } | null;
      const first = found?.found ? found.patients?.[0]?.full_name.split(" ")[0] : null;
      if (first && found?.number_ending) {
        conv.ctx.confirmNumber = found.number_ending;
        notes.push(
          `Caller ID found ${first}. Greet them by name and answer their request. Don't ask for their phone ` +
            "number and don't confirm it now: you'll confirm it in the booking question " +
            `("…, on the number ending ${found.number_ending}?").`,
        );
      }
    }

    for (let rnd = 0; rnd <= MAX_TOOL_ROUNDS; rnd++) {
      timings.rounds = rnd + 1;
      const msgs: ChatMessage[] = [{ role: "system", content: system }];
      const turnNotes = [...(safety.triggered ? [safety.instruction] : []), ...notes];
      for (const m of trim(conv.messages)) {
        if (turnNotes.length && m === userMsg)
          msgs.push({ ...m, content: `${m.content}\n\n[Clinic system note, not from the patient: ${turnNotes.join(" ")}]` });
        else msgs.push(m);
      }
      const t0 = performance.now();
      let first: number | null = null;
      let text = "";
      let calls: ToolCall[] = [];
      for await (const part of model.stream(msgs, rnd < MAX_TOOL_ROUNDS ? "auto" : "none")) {
        if ("text" in part) {
          if (first === null) {
            first = performance.now();
            if (timings.ttft_ms === null) timings.ttft_ms = Math.round(first - tTurn);
          }
          text += part.text;
          yield { type: "token", text: part.text };
        } else {
          timings.llm_calls.push({
            ms: Math.round(performance.now() - t0),
            first_token_ms: first ? Math.round(first - t0) : null,
            tool_calls: part.toolCalls.length,
          });
          calls = part.toolCalls;
        }
      }
      finalText = text;
      if (text.trim()) spoken.push(text.trim());
      if (rnd === MAX_TOOL_ROUNDS) calls = []; // hard stop: the model must answer now
      // With tool calls, keep content empty: some chat templates render content OR tool calls, never both.
      conv.messages.push(
        calls.length
          ? {
              role: "assistant",
              content: "",
              tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })),
            }
          : { role: "assistant", content: finalText || "" },
      );
      if (!calls.length) {
        if (rnd < MAX_TOOL_ROUNDS - 1 && !nudged) {
          const madeUp = ungrounded(finalText, conv.groundedTimes);
          const unsourced = FACT_QUESTION.test(userText) && !called.includes("get_clinic_info");
          const [reason, nudge] = madeUp.size
            ? ["ungrounded_times", nudgeUngrounded(madeUp)]
            : unsourced
              ? ["unsourced_fact", NUDGE_FACTS]
              : ANNOUNCED_ACTION.test(finalText)
                ? ["announced_action", NUDGE]
                : [null, null];
          if (nudge) {
            nudged = true;
            timings.nudged = reason;
            conv.messages.push({ role: "user", content: nudge });
            if (reason !== "announced_action" && finalText.trim()) {
              if (spoken[spoken.length - 1] === finalText.trim()) spoken.pop();
              yield { type: "retract", text: finalText, reason, times: [...madeUp].sort() };
            }
            continue;
          }
        }
        break;
      }
      for (const call of calls) yield* runTool(call);
    }

    if (!finalText.trim()) {
      finalText = "Sorry, I didn't catch that. Could you say it again?";
      spoken.push(finalText);
      conv.messages.push({ role: "assistant", content: finalText });
      yield { type: "token", text: finalText };
    }
  } catch (e) {
    console.error("LLM error", e);
    if (e instanceof APIConnectionError) yield { type: "error", message: "The language model isn't reachable right now." };
    else if (e instanceof APIError && e.status === 429)
      yield { type: "error", message: "Pearl is very busy right now (free model quota). Please try again in a minute." };
    else if (e instanceof APIError) yield { type: "error", message: `The language model returned an error: ${e.message}` };
    else throw e;
  }

  // Safety backstop: if a red flag fired and the model didn't escalate (or the model failed), escalate
  // deterministically. Outside the try on purpose: an LLM error must never skip it.
  if (safety.triggered && !called.includes("escalate_to_human")) {
    const call = {
      id: `auto_${crypto.randomUUID().slice(0, 8)}`,
      name: "escalate_to_human",
      arguments: JSON.stringify({
        reason: `Safety backstop: ${safety.rules.join(", ")}. Patient said: ${userText.slice(0, 200)}`,
        urgency: "urgent",
      }),
    };
    conv.messages.push(callMsg(call));
    yield* runTool(call, true);
    const said = finalText.toLowerCase();
    let note = /\bstaff\b|\bcall you\b/.test(said) ? "" : " A staff member will call you within 15 minutes.";
    if (safety.breathingOrSwallowing && !said.includes("emergency"))
      note += " If breathing or swallowing is getting harder, please go to the nearest hospital emergency department now.";
    if (note) {
      finalText = (finalText + note).trim();
      spoken.push(note.trim());
      conv.messages.push({ role: "assistant", content: finalText });
      yield { type: "token", text: note };
    }
  }


  const totalMs = Math.round(performance.now() - tTurn);
  timings.total_ms = totalMs;
  timings.llm_ms = timings.llm_calls.reduce((s, c) => s + Number(c.ms), 0);
  const turnText = spoken.join(" ");
  if (turnText) logs.push({ role: "assistant", content: turnText, latency_ms: totalMs });
  if (conv.id) {
    const res = await db()
      .from("messages")
      .insert(logs.map((l) => ({ conversation_id: conv.id, ...l })));
    if (res.error) console.warn(`message log failed: ${res.error.message}`);
  }
  await saveConversation(conv);
  if (conv.ctx.outcome !== outcomeBefore) timings.outcome_changed = true;
  yield { type: "done", text: turnText, outcome: conv.ctx.outcome, tools_called: called, timings };
}
