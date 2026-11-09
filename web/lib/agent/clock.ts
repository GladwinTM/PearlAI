// Clinic-timezone helpers and the date table injected into the system prompt (port of agent/src/smiledesk/clock.py).
// LLMs are bad at calendar arithmetic, so the model never computes dates itself: it reads them here.
// Local calendar dates are "YYYY-MM-DD" strings; instants are Date objects.

export type DateStr = string;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // Python weekday() order
const WEEKDAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface LocalParts {
  date: DateStr;
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

export function localParts(instant: Date, tz: string): LocalParts {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partsCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  const y = Number(p.year);
  const m = Number(p.month);
  const d = Number(p.day);
  return { date: `${p.year}-${p.month}-${p.day}`, y, m, d, h: Number(p.hour), mi: Number(p.minute) };
}

/** Offset of `tz` from UTC at `instant`, in minutes (e.g. +330 for Asia/Kolkata). */
function offsetMinutes(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  return Math.round((asUtc - Math.floor(instant.getTime() / 60000) * 60000) / 60000);
}

/** Clinic-local wall time → instant. */
export function localToInstant(date: DateStr, hour: number, minute: number, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60000;
  t = guess - offsetMinutes(new Date(t), tz) * 60000; // second pass settles DST edges
  return new Date(t);
}

export function addDays(date: DateStr, n: number): DateStr {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Python weekday(): Monday = 0 … Sunday = 6. */
export function pyWeekday(date: DateStr): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Postgres day-of-week: 0 = Sunday … 6 = Saturday (matches dentist_schedules.weekday). */
export function pgDow(date: DateStr): number {
  return (pyWeekday(date) + 1) % 7;
}

export function fmtDay(date: DateStr): string {
  const [, m, d] = date.split("-").map(Number);
  return `${WEEKDAYS[pyWeekday(date)]} ${d} ${MONTHS[m - 1]}`;
}

/** '9:00 AM', '12:30 PM' (Python strftime("%I:%M %p").lstrip("0")). */
export function fmtClock(h: number, mi: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function fmtTime(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  return fmtClock(p.h, p.mi);
}

export function fmtSlot(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  return `${fmtDay(p.date)}, ${fmtClock(p.h, p.mi)}`;
}

/** Compact clinic-local start for tool I/O: '2026-11-13T09:00'. */
export function fmtStart(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  return `${p.date}T${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}

/** 'HH:MM' local. */
export function hhmm(instant: Date, tz: string): string {
  return fmtStart(instant, tz).slice(11);
}

/** Parse an ISO datetime from the model. Naive values are clinic-local time. Throws on garbage. */
export function parseLocalDatetime(value: string, tz: string): Date {
  let v = String(value).trim().replace(" ", "T");
  if (v.endsWith("Z")) v = v.slice(0, -1) + "+00:00";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2})(?:\.\d+)?)?)?)?([+-]\d{2}:?\d{2})?$/.exec(v);
  if (!m) throw new RangeError(`Invalid isoformat string: '${value}'`);
  const [, y, mo, d, h = "00", mi = "00", sec = "00", off] = m;
  const date = `${y}-${mo}-${d}`;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(mi) > 59)
    throw new RangeError(`Invalid isoformat string: '${value}'`);
  if (addDays(date, 0) !== date) throw new RangeError(`Invalid date: '${value}'`); // e.g. 2026-02-30
  if (off) {
    const iso = `${date}T${h}:${mi}:${sec}${off.length === 5 ? off.slice(0, 3) + ":" + off.slice(3) : off}`;
    return new Date(iso);
  }
  return localToInstant(date, Number(h), Number(mi), tz);
}

/**
 * The block the model reads instead of doing date math. `working` maps Postgres weekday → short names of dentists
 * working that day (empty = closed). Hour granularity on purpose: the prompt stays byte-identical within the hour,
 * so the provider's prompt cache is reused across turns.
 */
export function dateContext(
  now: Date,
  tz: string,
  working: Record<number, string[]>,
  closedDates: Set<DateStr> = new Set(),
  days = 14,
): string {
  const p = localParts(now, tz);
  const today = p.date;
  const [, m, d] = today.split("-").map(Number);
  const lines = [
    `Now: ${WEEKDAYS_LONG[pyWeekday(today)]} ${d} ${MONTHS[m - 1]} ${p.y}, ` +
      `between ${fmtClock(p.h, 0)} and ${fmtClock((p.h + 1) % 24, 0)} (${tz})`,
  ];

  const cells: string[] = [];
  for (let i = 0; i <= days; i++) {
    const day = addDays(today, i);
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : null;
    const names = working[pgDow(day)] ?? [];
    const status = !names.length || closedDates.has(day) ? "CLOSED" : names.join(", ");
    cells.push(`${label ? `${label} ` : ""}${fmtDay(day)} = ${day} (${status})`);
  }
  lines.push("Next 14 days:\n  " + cells.join("\n  "));

  // "next <weekday>" = the first one strictly after today.
  const nexts: string[] = [];
  for (let wd = 0; wd < 7; wd++) {
    const delta = ((((wd - pyWeekday(today) - 1) % 7) + 7) % 7) + 1;
    const nd = addDays(today, delta);
    nexts.push(`next ${WEEKDAYS_LONG[wd]} = ${fmtDay(nd)} (${nd})`);
  }
  lines.push("Weekday names mean the NEXT occurrence: " + nexts.join("; "));

  const thisMon = addDays(today, -pyWeekday(today));
  const nextMon = addDays(thisMon, 7);
  const later = (a: DateStr, b: DateStr) => (a > b ? a : b);
  lines.push(
    `"this week" = ${fmtDay(later(today, thisMon))} – ${fmtDay(addDays(thisMon, 5))}; ` +
      `"next week" = ${fmtDay(nextMon)} – ${fmtDay(addDays(nextMon, 5))}; ` +
      `"early next week" = ${fmtDay(nextMon)} – ${fmtDay(addDays(nextMon, 1))}`,
  );
  lines.push('Times of day: morning = before 12 PM; afternoon = 12–4:30 PM; "evening" or "after work" = 4:30 PM onward.');
  return lines.join("\n");
}
