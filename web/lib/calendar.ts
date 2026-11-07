import { AGENT_URL } from "./config";

export interface CalDentist {
  id: string;
  full_name: string;
  short: string;
  specialty: string;
  schedule: Record<string, [string, string]>; // postgres weekday (0 = Sunday) → ["09:00", "18:00"]
}

export interface CalAppointment {
  id: string;
  dentist_id: string;
  dentist_name: string;
  appointment_type: string;
  appointment_name: string;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  patient_display: string;
  is_fixture: boolean;
  created_at: string;
}

export interface CalendarData {
  from: string;
  to: string;
  timezone: string;
  lunch: [string, string];
  dentists: CalDentist[];
  appointments: CalAppointment[];
}

export async function getCalendar(from: string, to: string, signal?: AbortSignal): Promise<CalendarData> {
  const res = await fetch(`${AGENT_URL}/api/calendar?from=${from}&to=${to}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`Calendar failed (${res.status})`);
  return (await res.json()) as CalendarData;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Wall-clock parts of an instant in the clinic's time zone (the viewer may be anywhere). */
export function clinicParts(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function fmtTime(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${pad(m)}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** Monday of the week to show first: this week, or next week once the clinic week is over (Sat evening/Sun). */
export function defaultWeekStart(today = new Date()): Date {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dow = d.getDay(); // 0 = Sunday
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((dow + 6) % 7));
  if (dow === 0 || (dow === 6 && today.getHours() >= 14)) monday.setDate(monday.getDate() + 7);
  return monday;
}

export function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
