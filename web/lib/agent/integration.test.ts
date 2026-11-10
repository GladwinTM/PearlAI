import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import fixtures from "./__fixtures__/parity.json";
import { loadClinic } from "./clinic";
import { type ChatLLM, type ChatMessage, newConversation, recoverFailedToolCall, runTurn, type ToolCall } from "./core";
import { db } from "./db";
import { fallbackFetch, parseFallbacks } from "./llm";
import { render } from "./prompts";
import { executeTool, ToolContext } from "./tools";
import { ChunkSplitter, forSpeech } from "../voice-text";

// Integration tests against LOCAL Supabase (make db-start). Skipped when it isn't running.
let dbUp = false;
beforeAll(async () => {
  try {
    const r = await db().from("dentists").select("id").limit(1);
    dbUp = !r.error;
  } catch {
    dbUp = false;
  }
});
const reset = async () => {
  await db().rpc("reset_demo_fixtures", {});
};

/** Next date (yyyy-mm-dd, clinic time) with the given Postgres weekday (0 = Sunday), strictly after today. */
function nextWeekday(dow: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== dow);
  return d.toISOString().slice(0, 10);
}

class ScriptedLLM implements ChatLLM {
  calls: ChatMessage[][] = [];
  constructor(private steps: [string, [string, Record<string, unknown>][]][]) {}
  async *stream(messages: ChatMessage[]) {
    this.calls.push(messages);
    const [text, calls] = this.steps.shift() ?? ["Okay.", []];
    if (text) for (const w of text.split(" ")) yield { text: w + " " };
    yield { toolCalls: calls.map(([name, args], i): ToolCall => ({ id: `c${this.calls.length}_${i}`, name, arguments: JSON.stringify(args) })) };
  }
}

async function collect(conv: ReturnType<typeof newConversation>, text: string, llm: ChatLLM) {
  const out = [];
  for await (const ev of runTurn(conv, text, llm)) out.push(ev);
  return out;
}

describe("with local Supabase", () => {
  beforeEach(async (ctx) => {
    if (!dbUp) ctx.skip();
    await reset();
  });

  it("renders the same system prompt as the Python agent", async () => {
    const clinic = await loadClinic(true);
    expect(render("v2", clinic, new Date(`${fixtures.render_v2.now}+05:30`))).toBe(fixtures.render_v2.text);
  });

  it("lookup_patient only accepts numbers the caller gave", async () => {
    const ctx = new ToolContext();
    const [refused] = await executeTool("lookup_patient", { phone: "98000 00001" }, ctx);
    expect(String(refused.error)).toContain("hasn't given this number");
    ctx.allowedPhones.add("+919800000001");
    const [found] = await executeTool("lookup_patient", { phone: "98000 00001" }, ctx);
    expect(found.found).toBe(true);
    expect((found.patients as { patient_id: string }[]).map((p) => p.patient_id)).toEqual(["P1", "P2"]);
  });

  it("Thursday is full: reason + alternatives, and only offered slots can be booked, after a confirmation", async () => {
    const ctx = new ToolContext(null, "chat");
    ctx.allowedPhones.add("+919800000001");
    await executeTool("lookup_patient", { phone: "9800000001" }, ctx);
    const [full] = await executeTool("check_availability", { date: nextWeekday(4), appointment_type: "checkup", dentist_id: "priya" }, ctx);
    expect(full.available).toBe(false);
    expect(String(full.reason)).toContain("fully booked");
    const alts = full.nearest_alternatives as { start: string; dentist_id: string; label: string }[];
    expect(alts.length).toBeGreaterThan(0);

    const [notOffered] = await executeTool(
      "book_appointment",
      { patient_id: "P1", dentist_id: "priya", appointment_type: "checkup", starts_at: `${nextWeekday(4)}T11:00` },
      ctx,
    );
    expect(String(notOffered.error)).toContain("wasn't returned by check_availability");

    const slot = alts[0];
    const args = { patient_id: "P1", dentist_id: slot.dentist_id, appointment_type: "checkup", starts_at: slot.start };
    ctx.lastAssistantText = `I have ${alts.map((a) => a.label).join(" or ")}. Which suits you?`;
    expect(String((await executeTool("book_appointment", args, ctx))[0].error)).toContain("Not confirmed");
    // Caller ID found Ravi: the confirmation question must name his number too.
    ctx.confirmNumber = "0001";
    ctx.lastAssistantText = `The earliest is ${slot.label}. Shall I book it for you?`;
    const [noNumber] = await executeTool("book_appointment", args, ctx);
    expect(String(noNumber.error)).toContain("phone number");
    expect(String(noNumber.hint)).toContain("number ending 0001");
    ctx.lastAssistantText = `The earliest is ${slot.label}. Shall I book it for you, on the number ending 0001?`;
    const [booked] = await executeTool("book_appointment", args, ctx);
    expect(ctx.confirmNumber).toBeNull();
    expect(booked.booked).toBe(true);
    expect(String(booked.summary)).toContain("Ravi Kumar");

    const [cancelled] = await executeTool("cancel_appointment", { appointment_id: String(booked.appointment_id) }, ctx);
    expect(cancelled.cancelled).toBe(true);
  });

  it("get_clinic_info answers from the FAQ with full-text search", async () => {
    const [res] = await executeTool("get_clinic_info", { question: "Do you take insurance?" }, new ToolContext());
    expect((res.results as { title: string }[])[0].title).toBe("Insurance");
    const [park] = await executeTool("get_clinic_info", { question: "can I park my scooter" }, new ToolContext());
    expect((park.results as { title: string }[])[0].title).toBe("Location and parking");
  });

  it("caller ID is looked up automatically, once", async () => {
    const conv = newConversation(null, "ravi", "chat", "v2");
    const ev = await collect(conv, "Hello", new ScriptedLLM([["Hi Ravi!", []]]));
    expect(ev[0]).toMatchObject({ type: "tool_call", name: "lookup_patient", auto: true });
    // Known caller: no number check up front; it's confirmed in the booking question (guarded by confirmNumber).
    expect(String(ev.at(-1)!.text)).toBe("Hi Ravi!");
    expect(conv.ctx.confirmNumber).toBe("0001");
    const ev2 = await collect(conv, "Thanks", new ScriptedLLM([["Bye", []]]));
    expect(ev2.some((e) => e.type === "tool_call")).toBe(false);
  });

  it("clinic facts answered from memory are retracted and looked up", async () => {
    const llm = new ScriptedLLM([
      ["Yes, we accept all insurance.", []],
      ["", [["get_clinic_info", { question: "insurance" }]]],
      ["We don't offer cashless insurance.", []],
    ]);
    const ev = await collect(newConversation(null, null, "chat", "v2"), "Do you take insurance?", llm);
    expect(ev.find((e) => e.type === "retract")).toMatchObject({ reason: "unsourced_fact" });
    const done = ev.at(-1)!;
    expect(done.tools_called).toEqual(["get_clinic_info"]);
    expect(String(done.text)).not.toContain("accept all insurance");
  });

  it("safety backstop escalates when the model doesn't, without repeating what Pearl said", async () => {
    const ev = await collect(
      newConversation(null, null, "chat", "v2"),
      "My face is swollen and I have a fever",
      new ScriptedLLM([["This may be serious. A staff member will call you shortly.", []]]),
    );
    expect(ev[0]).toMatchObject({ type: "safety", rules: ["swelling_with_fever"] });
    expect(ev.find((e) => e.type === "tool_call" && e.name === "escalate_to_human")).toMatchObject({ auto: true });
    expect(String(ev.at(-1)!.text).toLowerCase().split("staff member").length - 1).toBe(1);
    await db().from("escalations").delete().like("reason", "Safety backstop%");
  });

  it("safety backstop still escalates when the model is down", async () => {
    const { APIConnectionError } = await import("openai");
    const down: ChatLLM = {
      async *stream() {
        throw new APIConnectionError({ message: "connection refused" });
      },
    };
    const ev = await collect(newConversation(null, null, "chat", "v2"), "My face is swollen and I have a fever", down);
    expect(ev.some((e) => e.type === "error")).toBe(true);
    expect(ev.find((e) => e.type === "tool_call" && e.name === "escalate_to_human")).toMatchObject({ auto: true, args: { urgency: "urgent" } });
    expect(String(ev.at(-1)!.text)).toContain("staff member will call you");
    await db().from("escalations").delete().like("reason", "Safety backstop%");
  });
});

describe("LLM fallback and recovery", () => {
  it("parses fallback specs", () => {
    expect(parseFallbacks("openai/gpt-oss-120b, qwen/qwen3.8-27b:none,")).toEqual([["openai/gpt-oss-120b", null], ["qwen/qwen3.8-27b", "none"]]);
    expect(parseFallbacks("qwen3:8b")).toEqual([["qwen3:8b", null]]);
  });

  it("retries a rate-limited model on the next one with its own reasoning setting", async () => {
    const seen: { model: string; effort?: string }[] = [];
    const inner = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const b = JSON.parse(String(init!.body));
      seen.push({ model: b.model, effort: b.reasoning_effort });
      return new Response("{}", { status: ["a", "b"].includes(b.model) ? 429 : 200 });
    }) as typeof fetch;
    const f = fallbackFetch([["b", null], ["c", "none"]], inner);
    const res = await f("http://llm.test/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "a", reasoning_effort: "low" }) });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ model: "a", effort: "low" }, { model: "b", effort: "low" }, { model: "c", effort: "none" }]);
  });

  it("recovers a tool call the provider rejected (Groq tool_use_failed)", async () => {
    const { APIError } = await import("openai");
    const e = new APIError(400, {
      code: "tool_use_failed",
      failed_generation: '{"name": "escalate_to_human", "arguments": {"patient_id": null, "reason": "x", "urgency": "urgent"}}',
    }, "bad", new Headers());
    const call = recoverFailedToolCall(e);
    expect(call?.name).toBe("escalate_to_human");
    expect(JSON.parse(call!.arguments)).toMatchObject({ urgency: "urgent", patient_id: null });
    expect(recoverFailedToolCall(new APIError(400, { code: "other" }, "x", new Headers()))).toBeNull();
  });
});

describe("speech chunks", () => {
  it("releases the first clause at a comma, then whole sentences", () => {
    const s = new ChunkSplitter();
    const out = [
      ...s.push("Next Thursday Dr. Priya is fully booked, "),
      ...s.push("but I have 9:30 AM on Friday. Shall I book "),
      ...s.push("it?"),
    ];
    const rest = s.flush();
    expect(out).toEqual(["Next Thursday Dr. Priya is fully booked,", "but I have 9:30 AM on Friday."]);
    expect(rest).toBe("Shall I book it?");
  });

  it("blocks an unbacked 'it's booked' claim before it is spoken", () => {
    expect(forSpeech("Your appointment is booked for Friday.", false)).toEqual({ text: "Shall I go ahead and confirm that for you?", blocked: true });
    expect(forSpeech("Your appointment is booked for 12:00 PM.", true).text).toBe("Your appointment is booked for 12 PM.");
  });
});
