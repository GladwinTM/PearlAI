import "server-only";

import { addDays, type DateStr, fmtClock, localParts, localToInstant } from "./clock";
import { settings } from "./config";
import { db, rows } from "./db";

// Clinic reference data, cached briefly per server instance (port of agent/clinic.py).

const TTL_MS = 5 * 60 * 1000;

export interface Hours {
  start: string; // "HH:MM"
  end: string;
}

export class Dentist {
  constructor(
    public id: string,
    public fullName: string,
    public specialty: string,
    public services: Set<string>,
    public schedule: Map<number, Hours>, // postgres weekday → hours
  ) {}

  /** 'Dr. Priya' */
  get short(): string {
    const parts = this.fullName.split(/\s+/);
    return parts.length && parts[0].toLowerCase().startsWith("dr") ? parts.slice(0, 2).join(" ") : parts[0];
  }

  /** Short id the model uses in tool calls: 'priya'. */
  get key(): string {
    const parts = this.fullName
      .toLowerCase()
      .replaceAll(".", "")
      .split(/\s+/)
      .filter((p) => p && p !== "dr" && p !== "doctor");
    return parts[0] ?? this.id;
  }

  get daysText(): string {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return [...this.schedule.keys()]
      .sort((a, b) => a - b)
      .map((d) => names[d])
      .join("/");
  }
}

export interface ApptType {
  id: string;
  name: string;
  durationMinutes: number;
}

const ALIASES: Record<string, string> = {
  root_canal_treatment: "root_canal",
  rct: "root_canal",
  check_up: "checkup",
  consultation: "checkup",
  braces: "braces_consult",
  aligners: "braces_consult",
  scaling: "cleaning",
  emergency_visit: "emergency",
};

export class Clinic {
  constructor(
    public dentists: Dentist[],
    public types: Map<string, ApptType>,
    public lunch: Hours,
    public newPatientCutoff: string, // "HH:MM"
    public closures: [Date, Date][],
    public tz: string,
  ) {}

  /** By UUID, key, or (part of) a name: 'Dr. Priya', 'priya', 'Arjun Menon'. */
  dentist(ref: string | null | undefined): Dentist | null {
    if (!ref) return null;
    let r = String(ref).trim().toLowerCase();
    for (const d of this.dentists) if (r === d.id || r === d.key) return d;
    r = r.replace(/^(dr\.?|doctor)\s*/, "");
    for (const d of this.dentists) if (r && d.fullName.toLowerCase().includes(r)) return d;
    return null;
  }

  apptType(ref: string | null | undefined): ApptType | null {
    if (!ref) return null;
    let r = String(ref).trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
    r = ALIASES[r] ?? r;
    if (this.types.has(r)) return this.types.get(r)!;
    for (const t of this.types.values()) if (t.name.toLowerCase().replaceAll(" ", "_") === r) return t;
    return null;
  }

  workingByWeekday(): Record<number, string[]> {
    const out: Record<number, string[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    for (const d of this.dentists) for (const wd of d.schedule.keys()) out[wd].push(d.short.replace("Dr. ", ""));
    return out;
  }

  closedDates(): Set<DateStr> {
    const days = new Set<DateStr>();
    for (const [start, end] of this.closures) {
      let d = localParts(start, this.tz).date;
      while (localToInstant(d, 0, 0, this.tz) < end) {
        days.add(d);
        d = addDays(d, 1);
      }
    }
    return days;
  }
}

export const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** '9 AM', '6:30 PM' (Python strftime("%I:%M %p").lstrip("0").replace(":00", "")). */
export function fmtHour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return fmtClock(h, m).replace(":00", "");
}

let cache: { clinic: Clinic; at: number } | null = null;

export async function loadClinic(force = false): Promise<Clinic> {
  if (cache && !force && Date.now() - cache.at < TTL_MS) return cache.clinic;
  const c = db();
  const [settingsRes, servicesRes, schedRes, dentistsRes, typesRes, closuresRes] = await Promise.all([
    c.from("clinic_settings").select("*"),
    c.from("dentist_services").select("dentist_id, appointment_type_id"),
    c.from("dentist_schedules").select("dentist_id, weekday, start_time, end_time"),
    c.from("dentists").select("id, full_name, specialty").eq("is_active", true).order("full_name"),
    c.from("appointment_types").select("id, name, duration_minutes"),
    c.from("time_off").select("starts_at, ends_at").is("dentist_id", null),
  ]);
  const cs = rows<{ lunch_start: string; lunch_end: string; new_patient_cutoff: string }>(settingsRes)[0];
  const services = new Map<string, Set<string>>();
  for (const r of rows<{ dentist_id: string; appointment_type_id: string }>(servicesRes)) {
    if (!services.has(r.dentist_id)) services.set(r.dentist_id, new Set());
    services.get(r.dentist_id)!.add(r.appointment_type_id);
  }
  const sched = new Map<string, Map<number, Hours>>();
  for (const r of rows<{ dentist_id: string; weekday: number; start_time: string; end_time: string }>(schedRes)) {
    if (!sched.has(r.dentist_id)) sched.set(r.dentist_id, new Map());
    sched.get(r.dentist_id)!.set(Number(r.weekday), { start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) });
  }
  const dentists = rows<{ id: string; full_name: string; specialty: string }>(dentistsRes).map(
    (r) => new Dentist(r.id, r.full_name, r.specialty, services.get(r.id) ?? new Set(), sched.get(r.id) ?? new Map()),
  );
  const types = new Map<string, ApptType>();
  for (const r of rows<{ id: string; name: string; duration_minutes: number }>(typesRes))
    types.set(r.id, { id: r.id, name: r.name, durationMinutes: Number(r.duration_minutes) });
  const closures = rows<{ starts_at: string; ends_at: string }>(closuresRes).map(
    (r) => [new Date(r.starts_at), new Date(r.ends_at)] as [Date, Date],
  );
  const clinic = new Clinic(
    dentists,
    types,
    { start: cs.lunch_start.slice(0, 5), end: cs.lunch_end.slice(0, 5) },
    cs.new_patient_cutoff.slice(0, 5),
    closures,
    settings().clinicTimezone,
  );
  cache = { clinic, at: Date.now() };
  return clinic;
}
