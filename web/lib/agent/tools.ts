import "server-only";

import { type ApptType, type Clinic, type Dentist, loadClinic, minutesOf } from "./clinic";
import {
  addDays,
  type DateStr,
  fmtClock,
  fmtDay,
  fmtSlot,
  fmtStart,
  fmtTime,
  hhmm,
  localParts,
  parseLocalDatetime,
  pgDow,
} from "./clock";
import { settings } from "./config";
import { db, DbError, rows } from "./db";
import { spokenTimes } from "./grounding";

// Agent tools: OpenAI function schemas + executors (port of agent/tools.py; same results, errors and hints).
// - Executors never throw: failures come back as {error, hint} so the model can recover.
// - Writes only work for patients identified in THIS conversation (prompt-injection / guessed-id guard).
// - The model sees short handles (P1, A1, priya) and compact local times (2026-11-13T09:00), never UUIDs.

export type ToolResult = Record<string, unknown>;
const MAX_SLOTS = 6;

export interface ToolState {
  conversationId: string | null;
  channel: "chat" | "voice";
  knownPatientIds: string[];
  outcome: string | null;
  patientId: string | null;
  allowedPhones: string[];
  offered: string[];
  byHandle: Record<string, string>;
}

export class ToolContext {
  knownPatientIds = new Set<string>();
  outcome: string | null = null;
  patientId: string | null = null;
  /** Phone numbers the caller actually said (or caller ID). lookup_patient refuses anything else. */
  allowedPhones = new Set<string>();
  /** Slots check_availability returned, as "start|dentistKey". Bookings must use one. */
  offered = new Set<string>();
  /** Pearl's last message before the current turn. Writes need it to confirm that slot. null = guard off. */
  lastAssistantText: string | null = null;
  private byHandle: Record<string, string> = {};
  private byUuid: Record<string, string> = {};

  constructor(
    public conversationId: string | null = null,
    public channel: "chat" | "voice" = "chat",
  ) {}

  handle(uuid: string, prefix: string): string {
    if (this.byUuid[uuid]) return this.byUuid[uuid];
    const n = Object.keys(this.byHandle).filter((h) => h.startsWith(prefix)).length + 1;
    const h = `${prefix}${n}`;
    this.byHandle[h] = uuid;
    this.byUuid[uuid] = h;
    return h;
  }

  resolve(ref: unknown): string | null {
    const r = String(ref ?? "").trim();
    if (this.byHandle[r.toUpperCase()]) return this.byHandle[r.toUpperCase()];
    if (UUID.test(r)) return r.toLowerCase();
    return null;
  }

  rememberPatient(uuid: string): string {
    this.knownPatientIds.add(uuid);
    return this.handle(uuid, "P");
  }

  toJSON(): ToolState {
    return {
      conversationId: this.conversationId,
      channel: this.channel,
      knownPatientIds: [...this.knownPatientIds],
      outcome: this.outcome,
      patientId: this.patientId,
      allowedPhones: [...this.allowedPhones],
      offered: [...this.offered],
      byHandle: this.byHandle,
    };
  }

  static fromJSON(s: Partial<ToolState> | null | undefined): ToolContext {
    const ctx = new ToolContext(s?.conversationId ?? null, s?.channel ?? "chat");
    ctx.knownPatientIds = new Set(s?.knownPatientIds ?? []);
    ctx.outcome = s?.outcome ?? null;
    ctx.patientId = s?.patientId ?? null;
    ctx.allowedPhones = new Set(s?.allowedPhones ?? []);
    ctx.offered = new Set(s?.offered ?? []);
    for (const [h, u] of Object.entries(s?.byHandle ?? {})) {
      ctx.byHandle[h] = u;
      ctx.byUuid[u] = h;
    }
    return ctx;
  }
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const err = (error: string, hint = ""): ToolResult => (hint ? { error, hint } : { error });

interface Msg {
  role?: string;
  content?: unknown;
}

/** What Pearl said just before the caller's latest message ("" if nothing). */
export function assistantTextBeforeLastUser(messages: Msg[]): string {
  let seenUser = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    if (m.role === "user" && !seenUser) seenUser = true;
    else if (m.role === "user") return "";
    else if (m.role === "assistant" && seenUser && typeof m.content === "string" && m.content.trim()) return m.content;
  }
  return "";
}

/** A write needs the caller's yes to a question that named exactly this slot's time. */
function unconfirmed(ctx: ToolContext, when: Date, tz: string): ToolResult | null {
  const prev = ctx.lastAssistantText;
  if (prev === null) return null;
  const text = prev.replace(/\b(Dr|Mr|Mrs|Ms|St)\./g, "$1"); // "Dr. Priya" isn't the end of a sentence
  const questions = text.match(/[^.?!\n]*\?/g) ?? [];
  const target = hhmm(when, tz);
  if (questions.length) {
    const asked = spokenTimes(questions[questions.length - 1]);
    const all = spokenTimes(text);
    const only = (s: Set<string>) => s.size === 1 && s.has(target);
    if (only(asked) || (asked.size === 0 && only(all))) return null;
  }
  return err(
    "Not confirmed yet: the caller hasn't said yes to this exact slot.",
    `Don't book yet and don't say it's booked. Ask one question naming who, the visit, the dentist, ` +
      `${fmtDay(localParts(when, tz).date)} and ${fmtTime(when, tz)} ("Shall I book …?"), then wait for their yes.`,
  );
}

// ── Phone numbers ───────────────────────────────────────────────

const PHONE_IN_TEXT = /\+?\d[\d\s().-]{8,16}\d/g;

/** Indian mobile numbers → E.164. '98000 00001', '09800000001', '+91-98000-00001' → '+919800000001'. */
export function normalizePhone(raw: unknown): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  else if (digits.length === 13 && digits.startsWith("091")) digits = digits.slice(3);
  return digits.length === 10 && "6789".includes(digits[0]) ? "+91" + digits : null;
}

export function phonesInText(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(PHONE_IN_TEXT)) {
    const p = normalizePhone(m[0]);
    if (p) out.add(p);
  }
  return out;
}

// ── Schemas (identical to the Python agent's) ───────────────────

const TYPE_ENUM = ["checkup", "cleaning", "root_canal", "braces_consult", "emergency"];

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "lookup_patient",
      description:
        "Find patients by phone number. Families can share one number, so several patients may come back. " +
        "Returns each patient's id, whether they are new (no completed visit), and upcoming appointments.",
      parameters: {
        type: "object",
        properties: { phone: { type: "string", description: "Phone number as the caller said it" } },
        required: ["phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_patient",
      description: "Register a new patient. Use only after lookup_patient found no matching person.",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          phone: { type: "string" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD, optional" },
        },
        required: ["full_name", "phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Real open slots for one date. Call it as soon as you know the visit type and day, BEFORE " +
        "asking about times. If nothing is free it explains why and returns the nearest alternatives, so do not " +
        "call it repeatedly day by day.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD, taken from the date table" },
          appointment_type: { type: "string", enum: TYPE_ENUM },
          dentist_id: { type: "string", description: 'e.g. "priya", only if the patient asked for a dentist' },
          patient_id: { type: "string", description: 'e.g. "P1", so new-patient rules apply' },
          time_preference: {
            type: "string",
            description: "morning | afternoon | evening | HH:MM (24h). 'after work' = evening",
          },
        },
        required: ["date", "appointment_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book a slot returned by check_availability. ONLY call after the patient explicitly said yes " +
        "to the full summary (who, what, dentist, day, time).",
      parameters: {
        type: "object",
        properties: {
          patient_id: { type: "string", description: 'Handle of the person being treated, e.g. "P2"' },
          dentist_id: { type: "string" },
          appointment_type: { type: "string", enum: TYPE_ENUM },
          starts_at: { type: "string", description: "The slot's start exactly as check_availability returned it" },
          booked_by_patient_id: { type: "string", description: "If booking for a family member, the caller's own handle" },
        },
        required: ["patient_id", "dentist_id", "appointment_type", "starts_at"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_appointments",
      description: "Upcoming booked appointments for a patient (to reschedule or cancel).",
      parameters: { type: "object", properties: { patient_id: { type: "string" } }, required: ["patient_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_appointment",
      description: "Move an existing appointment to a new free slot (atomic). Confirm with the patient first.",
      parameters: {
        type: "object",
        properties: {
          appointment_id: { type: "string" },
          new_starts_at: { type: "string", description: "start from check_availability" },
          new_dentist_id: { type: "string", description: "Only if changing dentist" },
        },
        required: ["appointment_id", "new_starts_at"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description: "Cancel a booked appointment. Confirm with the patient first.",
      parameters: {
        type: "object",
        properties: { appointment_id: { type: "string" }, reason: { type: "string" } },
        required: ["appointment_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_clinic_info",
      description:
        "Search the clinic FAQ: prices, payment, insurance, location, parking, hours, policies, " +
        "first visit, aftercare, braces. Use it for ANY factual question about the clinic.",
      parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Hand the patient to a staff member. urgency='urgent' for red-flag symptoms " +
        "(swelling with fever, trouble breathing or swallowing, heavy bleeding, facial injury).",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
          urgency: { type: "string", enum: ["urgent", "normal"] },
          patient_id: { type: "string" },
        },
        required: ["reason", "urgency"],
      },
    },
  },
] as const;

export const TOOL_NAMES: string[] = TOOL_SCHEMAS.map((t) => t.function.name);
const ALLOWED_ARGS: Record<string, Set<string>> = Object.fromEntries(
  TOOL_SCHEMAS.map((t) => [t.function.name, new Set(Object.keys(t.function.parameters.properties))]),
);
const REQUIRED_ARGS: Record<string, readonly string[]> = Object.fromEntries(
  TOOL_SCHEMAS.map((t) => [t.function.name, t.function.parameters.required]),
);

// ── Helpers ─────────────────────────────────────────────────────

type Args = Record<string, string | undefined>;
interface Slot {
  starts_at: string;
  dentist_id: string;
  dentist_name?: string;
}

const tzOf = () => settings().clinicTimezone;
const todayLocal = () => localParts(new Date(), tzOf()).date;

function parseDate(value: unknown): DateStr | null {
  const v = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return addDays(v, 0) === v ? v : null;
}

function knownPatient(ctx: ToolContext, ref: unknown): [string, null] | [null, ToolResult] {
  if (!ref) return [null, err("patient_id is required.", "Call lookup_patient with the caller's phone number first.")];
  const uuid = ctx.resolve(ref);
  if (!uuid || !ctx.knownPatientIds.has(uuid))
    return [
      null,
      err(
        `Patient '${ref}' hasn't been identified in this conversation.`,
        "Call lookup_patient with the caller's phone number (or create_patient) and use a handle it returns.",
      ),
    ];
  return [uuid, null];
}

async function isNewPatient(patientId: string): Promise<boolean> {
  const res = await db().from("appointments").select("id").eq("patient_id", patientId).eq("status", "completed").limit(1);
  return rows(res).length === 0;
}

interface Upcoming {
  appointment_id: string;
  patient_uuid: string;
  patient: string | null;
  type: string;
  dentist: string | null;
  when: string;
}

async function upcoming(ctx: ToolContext, patientIds: string[]): Promise<Upcoming[]> {
  if (!patientIds.length) return [];
  const res = await db()
    .from("appointments")
    .select(
      "id, patient_id, starts_at, appointment_type_id, dentists(full_name), patients!appointments_patient_id_fkey(full_name)",
    )
    .in("patient_id", patientIds)
    .eq("status", "booked")
    .gte("starts_at", new Date().toISOString())
    .order("starts_at");
  type Row = {
    id: string;
    patient_id: string;
    starts_at: string;
    appointment_type_id: string;
    dentists: { full_name: string } | null;
    patients: { full_name: string } | null;
  };
  return rows<Row>(res).map((r) => ({
    appointment_id: ctx.handle(r.id, "A"),
    patient_uuid: r.patient_id,
    patient: r.patients?.full_name ?? null,
    type: r.appointment_type_id,
    dentist: r.dentists?.full_name ?? null,
    when: fmtSlot(new Date(r.starts_at), tzOf()),
  }));
}

const publicAppt = (a: Upcoming) => {
  const out: Partial<Upcoming> = { ...a };
  delete out.patient_uuid; // internal: lets lookup_patient group appointments by person
  return out;
};

async function rpcSlots(d: DateStr, typeId: string, dentistId: string | null, isNew: boolean): Promise<Slot[]> {
  const res = await db().rpc("get_available_slots", {
    p_date: d,
    p_appointment_type: typeId,
    p_dentist_id: dentistId,
    p_is_new_patient: isNew,
  });
  return rows<Slot>(res);
}

type Window = [number, number] | null; // minutes since midnight, [start, end)

/** → [window, target minutes, normalized label]. */
function parsePref(pref: string | undefined): [Window, number | null, string | null] {
  if (!pref) return [null, null, null];
  const p = pref.trim().toLowerCase();
  if (["morning", "am", "before noon"].includes(p)) return [[0, 12 * 60], null, "morning"];
  if (["afternoon", "lunchtime", "midday"].includes(p)) return [[12 * 60, 16 * 60 + 30], null, "afternoon"];
  if (["evening", "after work", "after office", "late", "night", "pm evening"].includes(p))
    return [[16 * 60 + 30, 23 * 60 + 59], null, "evening"];
  const m = /^(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?$/.exec(p);
  if (m) {
    let h = Number(m[1]);
    const mi = Number(m[2] ?? 0);
    const ap = m[3];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 7) h += 12; // "at 5" in a clinic context means 5 PM
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59)
      return [null, h * 60 + mi, `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`];
  }
  return [null, null, null];
}

const localMinutes = (s: Slot) => {
  const p = localParts(new Date(s.starts_at), tzOf());
  return p.h * 60 + p.mi;
};
const ts = (s: Slot) => new Date(s.starts_at).getTime();

/** Up to `limit` slots near the preference, spread ≥30 min apart per dentist. → [picked, matchedPreference]. */
function pick(slots: Slot[], window: Window, target: number | null, limit: number): [Slot[], boolean] {
  let pool = slots;
  let matched = true;
  let tgt = target;
  if (window) {
    const inside = slots.filter((s) => window[0] <= localMinutes(s) && localMinutes(s) < window[1]);
    matched = inside.length > 0;
    if (inside.length) pool = inside;
    else tgt = window[0] > 0 ? window[0] : window[1]; // nothing in the window: closest times to it
  }
  if (tgt !== null) {
    const t = tgt;
    pool = [...pool].sort((a, b) => Math.abs(localMinutes(a) - t) - Math.abs(localMinutes(b) - t) || ts(a) - ts(b));
  }
  const picked: Slot[] = [];
  for (const s of pool) {
    if (picked.some((p) => p.dentist_id === s.dentist_id && Math.abs(ts(p) - ts(s)) < 1800 * 1000)) continue;
    picked.push(s);
    if (picked.length >= limit) break;
  }
  if (picked.length < limit)
    for (const s of pool) {
      if (!picked.includes(s)) picked.push(s);
      if (picked.length >= limit) break;
    }
  picked.sort((a, b) => ts(a) - ts(b));
  return [picked, matched];
}

function fmt(c: Clinic, s: Slot) {
  const t = new Date(s.starts_at);
  const d = c.dentist(s.dentist_id);
  const short = d ? d.short : s.dentist_name;
  return { start: fmtStart(t, c.tz), dentist_id: d ? d.key : s.dentist_id, label: `${fmtSlot(t, c.tz)}, ${short}` };
}

const cutoffText = (c: Clinic) => fmtClock(...(c.newPatientCutoff.split(":").map(Number) as [number, number])).replace(":00", "");

async function whyNone(c: Clinic, d: DateStr, t: ApptType, dentist: Dentist | null, isNew: boolean): Promise<string> {
  const day = fmtDay(d);
  const today = todayLocal();
  if (d < today) return `${day} is in the past.`;
  const eligible = c.dentists.filter((x) => x.services.has(t.id));
  if (!c.dentists.some((x) => x.schedule.has(pgDow(d))) || c.closedDates().has(d))
    return `The clinic is closed on ${day}.` + (pgDow(d) === 0 ? " We're closed on Sundays." : "");
  if (dentist && !dentist.services.has(t.id)) {
    const who = eligible.map((x) => x.fullName).join(" and ") || "nobody";
    return `${dentist.fullName} doesn't do ${t.name.toLowerCase()}s; ${who} does.`;
  }
  if (dentist && !dentist.schedule.has(pgDow(d)))
    return `${dentist.fullName} only works ${dentist.daysText}, not ${day.split(" ")[0]}.`;
  const pool = dentist ? [dentist] : eligible;
  const working = pool.filter((x) => x.schedule.has(pgDow(d)));
  if (!working.length) {
    const names = eligible.map((x) => `${x.fullName} works ${x.daysText}`).join("; ");
    return `Nobody who does ${t.name.toLowerCase()}s works on ${day}. ${names}.`;
  }
  const ids = working.map((x) => x.id);
  if (isNew) {
    for (const i of ids)
      if ((await rpcSlots(d, t.id, i, false)).length)
        return `New patients are seen only before ${cutoffText(c)}, and there are no earlier openings on ${day}.`;
  }
  if (t.durationMinutes > 30) {
    const checkupDentists = new Set(c.dentists.filter((x) => x.services.has("checkup")).map((x) => x.id));
    for (const i of ids)
      if (checkupDentists.has(i) && (await rpcSlots(d, "checkup", i, isNew)).length)
        return `A ${t.name.toLowerCase()} needs ${t.durationMinutes} minutes and the free gaps on ${day} are shorter than that.`;
  }
  if (d === today) return "There are no more openings today.";
  const who = dentist ? `${working[0].fullName} is` : "All our dentists are";
  return `${who} fully booked on ${day}.`;
}

/** Nearest openings on the next open days (up to 7 open days checked), max MAX_SLOTS, ≤2 per day. */
async function alternatives(
  c: Clinic,
  after: DateStr,
  t: ApptType,
  dentist: Dentist | null,
  isNew: boolean,
  window: Window,
  target: number | null,
) {
  const found: ReturnType<typeof fmt>[] = [];
  let openDaysChecked = 0;
  let d = after;
  const closed = c.closedDates();
  for (let i = 0; i < 21; i++) {
    d = addDays(d, 1);
    if (closed.has(d) || !c.dentists.some((x) => x.schedule.has(pgDow(d)))) continue;
    openDaysChecked++;
    const daySlots = await rpcSlots(d, t.id, dentist?.id ?? null, isNew);
    if (daySlots.length) found.push(...pick(daySlots, window, target, 2)[0].map((s) => fmt(c, s)));
    if (found.length >= MAX_SLOTS || openDaysChecked >= 7) break;
  }
  return found.slice(0, MAX_SLOTS);
}

function rememberOffers(ctx: ToolContext, out: ToolResult): ToolResult {
  for (const key of ["slots", "nearest_alternatives", "other_dentists_same_day"])
    for (const slot of (out[key] as { start: string; dentist_id: string }[] | undefined) ?? [])
      ctx.offered.add(`${slot.start}|${slot.dentist_id}`);
  return out;
}

// ── Executors ───────────────────────────────────────────────────

async function lookupPatient(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const e164 = normalizePhone(a.phone);
  if (!e164) return err(`'${a.phone}' isn't a valid Indian mobile number.`, "Ask for the 10-digit mobile number.");
  if (!ctx.allowedPhones.has(e164))
    return err(
      "The caller hasn't given this number in the conversation.",
      "Ask the caller for their mobile number and use exactly what they say. Never guess a number.",
    );
  const found = rows<{ id: string; full_name: string; date_of_birth: string | null }>(
    await db().from("patients").select("id, full_name, date_of_birth").eq("phone", e164).order("created_at"),
  );
  if (!found.length)
    return { found: false, phone: e164, hint: "No patient with this number. Ask for their full name and use create_patient." };
  const ids = found.map((p) => p.id);
  ids.forEach((i) => ctx.rememberPatient(i));
  if (ctx.patientId === null) ctx.patientId = ids[0];
  const up = await upcoming(ctx, ids);
  const patients = [];
  for (const p of found)
    patients.push({
      patient_id: ctx.handle(p.id, "P"),
      full_name: p.full_name,
      date_of_birth: p.date_of_birth,
      is_new: await isNewPatient(p.id),
      upcoming: up.filter((x) => x.patient_uuid === p.id).map(publicAppt),
    });
  const out: ToolResult = {
    found: true,
    phone: e164,
    number_ending: e164.slice(-4),
    patients,
    next_step:
      "If the caller asked a question about the clinic (prices, insurance, parking, hours, payment, " +
      "policies), call get_clinic_info now. If they said what visit and which day they want, call check_availability " +
      "now (don't ask for a time of day first). Otherwise ask what they need.",
  };
  if (patients.length > 1)
    out.note =
      `${patients.length} people share this number. Book with the patient_id of the person being treated: ` +
      "if the caller already said it's for themselves (or named the person), use that; ask only if it's unclear.";
  return out;
}

async function createPatient(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const name = String(a.full_name ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (name.length < 2) return err("A full name is required.");
  const e164 = normalizePhone(a.phone);
  if (!e164) return err(`'${a.phone}' isn't a valid Indian mobile number.`, "Ask for the 10-digit mobile number.");
  const dob = a.date_of_birth ? parseDate(a.date_of_birth) : null;
  const existing = rows<{ id: string; full_name: string }>(await db().from("patients").select("id, full_name").eq("phone", e164));
  for (const p of existing)
    if (p.full_name.toLowerCase() === name.toLowerCase())
      return { created: false, patient_id: ctx.rememberPatient(p.id), full_name: p.full_name, note: "Already registered." };
  const payload: Record<string, string> = { full_name: name, phone: e164 };
  if (dob) payload.date_of_birth = dob;
  const p = rows<{ id: string; full_name: string }>(await db().from("patients").insert(payload).select())[0];
  const handle = ctx.rememberPatient(p.id);
  ctx.patientId = ctx.patientId ?? p.id;
  return { created: true, patient_id: handle, full_name: p.full_name, is_new: true };
}

async function checkAvailability(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const c = await loadClinic();
  const d = parseDate(a.date);
  if (!d) return err(`Invalid date '${a.date}'.`, "Use YYYY-MM-DD from the date table.");
  const t = c.apptType(a.appointment_type);
  if (!t) return err(`Unknown appointment type '${a.appointment_type}'.`, `Use one of: ${[...c.types.keys()].join(", ")}.`);
  const dentist = a.dentist_id ? c.dentist(a.dentist_id) : null;
  if (a.dentist_id && !dentist)
    return err(`Unknown dentist '${a.dentist_id}'.`, "Use a dentist id from the clinic list, or leave it out.");
  const today = todayLocal();
  if (d > addDays(today, 90)) return err("We only book up to 90 days ahead.");

  let isNew = false;
  if (a.patient_id) {
    const [pid, bad] = knownPatient(ctx, a.patient_id);
    if (bad) return bad;
    isNew = await isNewPatient(pid);
  }

  const [window, target, prefLabel] = parsePref(a.time_preference);
  const base: ToolResult = {
    date: d,
    day: fmtDay(d),
    appointment_type: t.id,
    duration_minutes: t.durationMinutes,
    new_patient_rules: isNew,
  };
  if (dentist) base.dentist = dentist.fullName;
  if (prefLabel) base.time_preference = prefLabel;

  const slots = d >= today ? await rpcSlots(d, t.id, dentist?.id ?? null, isNew) : [];
  if (slots.length) {
    const [picked, matched] = pick(slots, window, target, MAX_SLOTS);
    const out: ToolResult = { ...base, available: true, slots: picked.map((s) => fmt(c, s)), total_open_slots: slots.length };
    const notes: string[] = [];
    if (prefLabel && window && !matched) notes.push(`No ${prefLabel} openings on ${fmtDay(d)}; these are the closest times.`);
    if (target !== null && !slots.some((s) => localMinutes(s) === target)) {
      if (isNew && target >= minutesOf(c.newPatientCutoff))
        notes.push(`New patients are seen only before ${cutoffText(c)}; these are the closest earlier times.`);
      else notes.push(`${fmtClock(Math.floor(target / 60), target % 60)} isn't available; these are the closest times.`);
    }
    if (notes.length) out.note = notes.join(" ");
    return rememberOffers(ctx, out);
  }

  const out: ToolResult = { ...base, available: false, reason: await whyNone(c, d, t, dentist, isNew) };
  const yesterday = addDays(today, -1);
  out.nearest_alternatives = await alternatives(c, d > yesterday ? d : yesterday, t, dentist, isNew, window, target);
  if (dentist) {
    const others = c.dentists.filter((x) => x.id !== dentist.id && x.services.has(t.id) && x.schedule.has(pgDow(d)));
    const sameDay: Slot[] = [];
    if (d >= today) for (const x of others) sameDay.push(...(await rpcSlots(d, t.id, x.id, isNew)));
    if (sameDay.length) out.other_dentists_same_day = pick(sameDay, window, target, 3)[0].map((s) => fmt(c, s));
  }
  return rememberOffers(ctx, out);
}

interface ApptRow {
  id: string;
  patient_id: string;
  booked_by_patient_id?: string | null;
  dentist_id: string;
  appointment_type_id: string;
  starts_at: string;
  status: string;
  notes?: string | null;
}

function apptSummary(ctx: ToolContext, a: ApptRow, c: Clinic) {
  const when = new Date(a.starts_at);
  const dent = c.dentist(a.dentist_id);
  const typ = c.types.get(a.appointment_type_id);
  return {
    appointment_id: ctx.handle(a.id, "A"),
    type: a.appointment_type_id,
    dentist: dent ? dent.fullName : a.dentist_id,
    when: fmtSlot(when, c.tz),
    start: fmtStart(when, c.tz),
    duration_minutes: typ ? typ.durationMinutes : null,
    status: a.status,
  };
}

function mapBookingError(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof DbError ? e.code : undefined;
  if (msg.includes("SLOT_UNAVAILABLE"))
    return err("That slot is no longer available.", "Call check_availability again and offer the closest alternatives.");
  if (code === "23P01") return err("This patient already has another appointment at that time.", "Pick a different time.");
  if (msg.includes("PATIENT_NOT_FOUND")) return err("Patient not found.", "Use lookup_patient or create_patient first.");
  if (msg.includes("APPOINTMENT_NOT_ACTIVE"))
    return err("That appointment is no longer active.", "Call list_appointments to see current bookings.");
  if (code === "22P02") return err("An id or timestamp was malformed.", "Use ids and starts_at exactly as returned by earlier tools.");
  console.warn(`booking error ${code}: ${msg}`);
  return err(`Booking failed: ${msg}`);
}

async function bookAppointment(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const [pid, bad] = knownPatient(ctx, a.patient_id);
  if (bad) return bad;
  let bookedBy: string | null = null;
  if (a.booked_by_patient_id) {
    const [b, bad2] = knownPatient(ctx, a.booked_by_patient_id);
    if (bad2) return bad2;
    bookedBy = b;
  }
  const c = await loadClinic();
  const dentist = c.dentist(a.dentist_id);
  const t = c.apptType(a.appointment_type);
  if (!dentist || !t) return err("Unknown dentist or appointment type.", "Use values returned by check_availability.");
  let when: Date;
  try {
    when = parseLocalDatetime(String(a.starts_at), c.tz);
  } catch {
    return err(`Invalid starts_at '${a.starts_at}'.`, "Use starts_at exactly as returned by check_availability.");
  }
  if (!ctx.offered.has(`${fmtStart(when, c.tz)}|${dentist.key}`))
    return err(
      "That time wasn't returned by check_availability in this conversation.",
      "Call check_availability for that day, offer the real times, and confirm with the patient before booking.",
    );
  const notConfirmed = unconfirmed(ctx, when, c.tz);
  if (notConfirmed) return notConfirmed;
  let appt: ApptRow;
  try {
    appt = rows<ApptRow>(
      await db().rpc("book_appointment", {
        p_patient_id: pid,
        p_dentist_id: dentist.id,
        p_appointment_type: t.id,
        p_starts_at: when.toISOString(),
        p_source: ctx.channel,
        p_conversation_id: ctx.conversationId,
        p_booked_by: bookedBy && bookedBy !== pid ? bookedBy : null,
      }),
    )[0];
  } catch (e) {
    const out = mapBookingError(e);
    if (String(out.error).includes("no longer available")) {
      const alt = await checkAvailability(ctx, {
        date: localParts(when, c.tz).date,
        appointment_type: t.id,
        dentist_id: dentist.id,
        patient_id: a.patient_id,
        time_preference: hhmm(when, c.tz),
      });
      out.alternatives = alt.slots ?? alt.nearest_alternatives ?? [];
    }
    return out;
  }
  ctx.outcome = "booked";
  ctx.patientId = pid;
  const s = apptSummary(ctx, appt, c);
  const name = rows<{ full_name: string }>(await db().from("patients").select("full_name").eq("id", pid))[0].full_name;
  return { booked: true, ...s, patient: name, summary: `${t.name} with ${s.dentist} on ${s.when} for ${name}` };
}

async function listAppointments(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const [pid, bad] = knownPatient(ctx, a.patient_id);
  if (bad) return bad;
  return { patient_id: ctx.handle(pid, "P"), appointments: (await upcoming(ctx, [pid])).map(publicAppt) };
}

async function ownedAppointment(ctx: ToolContext, appointmentId: unknown): Promise<ApptRow | ToolResult> {
  const uuid = ctx.resolve(appointmentId);
  if (!uuid) return err(`Unknown appointment_id '${appointmentId}'.`, "Use an appointment_id (like A1) from list_appointments.");
  const found = rows<ApptRow>(await db().from("appointments").select("*").eq("id", uuid));
  if (!found.length) return err("Appointment not found.", "Call list_appointments.");
  const appt = found[0];
  if (!ctx.knownPatientIds.has(appt.patient_id) && !ctx.knownPatientIds.has(appt.booked_by_patient_id ?? ""))
    return err("That appointment doesn't belong to the identified caller.", "Call lookup_patient first.");
  return appt;
}

async function rescheduleAppointment(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const appt = await ownedAppointment(ctx, a.appointment_id);
  if ("error" in appt) return appt as ToolResult;
  const old = appt as ApptRow;
  const c = await loadClinic();
  const dentist = a.new_dentist_id ? c.dentist(a.new_dentist_id) : null;
  if (a.new_dentist_id && !dentist) return err(`Unknown dentist '${a.new_dentist_id}'.`);
  let when: Date;
  try {
    when = parseLocalDatetime(String(a.new_starts_at), c.tz);
  } catch {
    return err(`Invalid new_starts_at '${a.new_starts_at}'.`, "Use starts_at from check_availability.");
  }
  const targetDentist = dentist ?? c.dentist(old.dentist_id);
  if (!targetDentist || !ctx.offered.has(`${fmtStart(when, c.tz)}|${targetDentist.key}`))
    return err(
      "That time wasn't returned by check_availability in this conversation.",
      "Call check_availability for the new day, offer the real times, and confirm before rescheduling.",
    );
  const notConfirmed = unconfirmed(ctx, when, c.tz);
  if (notConfirmed) return notConfirmed;
  let updated: ApptRow;
  try {
    updated = rows<ApptRow>(
      await db().rpc("reschedule_appointment", {
        p_appointment_id: old.id,
        p_new_starts_at: when.toISOString(),
        p_new_dentist_id: dentist?.id ?? null,
        p_source: ctx.channel,
        p_conversation_id: ctx.conversationId,
      }),
    )[0];
  } catch (e) {
    return mapBookingError(e);
  }
  ctx.outcome = "rescheduled";
  ctx.patientId = old.patient_id;
  const oldWhen = fmtSlot(new Date(old.starts_at), c.tz);
  const s = apptSummary(ctx, updated, c);
  return { rescheduled: true, old_when: oldWhen, ...s, summary: `Moved from ${oldWhen} to ${s.when} with ${s.dentist}` };
}

async function cancelAppointment(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const appt = await ownedAppointment(ctx, a.appointment_id);
  if ("error" in appt) return appt as ToolResult;
  const old = appt as ApptRow;
  if (old.status !== "booked") return err(`That appointment is already ${old.status}.`, "Call list_appointments to see current bookings.");
  const notes =
    [old.notes, a.reason ? `Cancelled via ${ctx.channel}: ${a.reason}` : null].filter(Boolean).join(" | ") || null;
  const updated = rows<ApptRow>(
    await db().from("appointments").update({ status: "cancelled", notes }).eq("id", old.id).eq("status", "booked").select(),
  );
  if (!updated.length) return err("That appointment could not be cancelled (it changed meanwhile).", "Call list_appointments.");
  ctx.outcome = "cancelled";
  ctx.patientId = old.patient_id;
  return { cancelled: true, ...apptSummary(ctx, updated[0], await loadClinic()) };
}

async function escalateToHuman(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const urgency = String(a.urgency ?? "normal").toLowerCase() === "urgent" ? "urgent" : "normal";
  const resolved = a.patient_id ? ctx.resolve(a.patient_id) : null;
  const pid = resolved && ctx.knownPatientIds.has(resolved) ? resolved : ctx.patientId;
  const rec = rows<{ id: number }>(
    await db()
      .from("escalations")
      .insert({ conversation_id: ctx.conversationId, patient_id: pid, urgency, reason: String(a.reason).slice(0, 500) })
      .select(),
  )[0];
  ctx.outcome = "escalated";
  const message =
    urgency === "urgent"
      ? "A staff member will call you within 15 minutes."
      : "A staff member will call you back today during clinic hours.";
  return { escalated: true, escalation_id: rec.id, urgency, message_for_patient: message };
}

// Full-text FAQ search: expand everyday words to the FAQ's vocabulary (no embedding model in serverless).
const SYNONYMS: [RegExp, string][] = [
  [/\b(insur\w*|cashless|claim\w*|mediclaim)\b/i, "insurance insurer claim reimbursement"],
  [/\b(price\w*|cost\w*|fee\w*|charge\w*|how much|rate\w*|expensive|cheap)\b/i, "prices treatment"],
  [/\b(pay\w*|card\w*|upi|cash|emi|gpay|paytm)\b/i, "payment methods accept"],
  [/\b(park\w*|car|bike|scooter|two.?wheeler)\b/i, "parking basement"],
  [/\b(where|address|locat\w*|direction\w*|reach|find you|lift)\b/i, "location address road"],
  [/\b(open\w*|hours?|timings?|close\w*|sunday|saturday|weekend)\b/i, "opening hours open closed"],
  [/\b(invisalign|aligner\w*|brace\w*|straighten\w*|crooked)\b/i, "braces aligners"],
  [/\b(cancel\w*|no.?show|reschedul\w*)\b/i, "cancellation policy"],
  [/\b(first (visit|time|appointment)|new patient|bring)\b/i, "first visit bring"],
  [/\b(after|aftercare|sore\w*|recover\w*)\b/i, "after soreness"],
  [/\b(emergenc\w*|urgent|knocked|broken tooth|severe pain)\b/i, "emergencies emergency"],
];

export function expandQuery(q: string): string {
  return [q, ...SYNONYMS.filter(([re]) => re.test(q)).map(([, words]) => words)].join(" ");
}

async function getClinicInfo(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const q = String(a.question ?? "").trim();
  if (!q) return err("Empty question.");
  const res = rows<{ title: string; content: string; rank: number }>(
    await db().rpc("search_kb", { p_query: expandQuery(q), p_limit: 3 }),
  );
  if (!res.length)
    return { results: [], hint: "Nothing in the clinic FAQ covers this. Say you don't know and offer to connect them to staff." };
  if (ctx.outcome === null) ctx.outcome = "info";
  return { results: res.map((r) => ({ title: r.title, content: r.content, relevance: Math.round(r.rank * 1000) / 1000 })) };
}

const EXECUTORS: Record<string, (ctx: ToolContext, a: Args) => Promise<ToolResult>> = {
  lookup_patient: lookupPatient,
  create_patient: createPatient,
  check_availability: checkAvailability,
  book_appointment: bookAppointment,
  list_appointments: listAppointments,
  reschedule_appointment: rescheduleAppointment,
  cancel_appointment: cancelAppointment,
  get_clinic_info: getClinicInfo,
  escalate_to_human: escalateToHuman,
};

/** Run a tool by name. Returns [result, ms]. Never throws. */
export async function executeTool(name: string, args: Record<string, unknown> | null, ctx: ToolContext): Promise<[ToolResult, number]> {
  const t0 = performance.now();
  let result: ToolResult;
  try {
    if (!EXECUTORS[name]) return [err(`Unknown tool '${name}'.`, `Available tools: ${TOOL_NAMES.join(", ")}.`), 0];
    const a: Args = {};
    for (const [k, v] of Object.entries(args ?? {}))
      if (ALLOWED_ARGS[name].has(k) && v !== null && v !== undefined && v !== "" && v !== "null") a[k] = String(v);
    const missing = REQUIRED_ARGS[name].filter((k) => !(k in a));
    if (missing.length) return [err(`Missing required argument(s): ${missing.join(", ")}.`), 0];
    result = await EXECUTORS[name](ctx, a);
  } catch (e) {
    console.error(`tool ${name} crashed`, e);
    result = err(
      `The ${name} tool failed: ${e instanceof Error ? e.constructor.name : "Error"}.`,
      "Apologise briefly and offer to connect the patient to staff.",
    );
  }
  return [result, Math.round(performance.now() - t0)];
}
