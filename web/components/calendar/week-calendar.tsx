"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  addDays,
  type CalAppointment,
  type CalendarData,
  clinicParts,
  defaultWeekStart,
  fmtTime,
  getCalendar,
  isoDate,
  toMinutes,
} from "@/lib/calendar";
import { cn } from "@/lib/utils";

interface Props {
  /** Poll every 2 s while a conversation is active, otherwise every 20 s. */
  live?: boolean;
  /** Bump to refetch now (e.g. right after a booking tool succeeded). */
  refreshKey?: number;
  /** Jump to the week containing this date (yyyy-mm-dd), e.g. a just-booked appointment. */
  focusDate?: string | null;
  className?: string;
}

interface Placed extends CalAppointment {
  date: string;
  start: number;
  end: number;
}

const DAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
const RANGE_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/**
 * A week of the clinic at a glance: one row per dentist, one mini timeline per day. Pearl's bookings animate in;
 * demo fixtures are greyed; names are masked by the API ("Ravi K."). A plain-text day list below is the accessible view.
 */
export function WeekCalendar({ live, refreshKey = 0, focusDate, className }: Props) {
  const reduce = useReducedMotion();
  const [weekStart, setWeekStart] = useState<Date>(() => defaultWeekStart());
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);
  const knownWeek = useRef<string>("");

  const from = isoDate(weekStart);
  const to = isoDate(addDays(weekStart, 5));

  useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      try {
        const d = await getCalendar(from, to, ctrl.signal);
        setError(null);
        setData(d);
        const ids = new Set(d.appointments.map((a) => a.id));
        // Highlight appointments that appeared since the last poll of the same week.
        if (known.current && knownWeek.current === from) {
          const added = [...ids].filter((id) => !known.current?.has(id));
          if (added.length) {
            setFresh((f) => new Set([...f, ...added]));
            setTimeout(() => setFresh((f) => new Set([...f].filter((x) => !added.includes(x)))), 6000);
          }
        }
        known.current = ids;
        knownWeek.current = from;
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("The calendar couldn't load. It will retry.");
      }
    };
    void load();
    const t = setInterval(() => void load(), live ? 2000 : 20000);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [from, to, live, refreshKey]);

  // Jump to the week of a just-booked appointment (adjusting state during render, not in an effect).
  const [prevFocus, setPrevFocus] = useState<string | null | undefined>(null);
  if (focusDate !== prevFocus) {
    setPrevFocus(focusDate);
    if (focusDate) {
      const [y, m, d] = focusDate.split("-").map(Number);
      const target = defaultWeekStart(new Date(y, m - 1, d, 9));
      if (isoDate(target) !== isoDate(weekStart)) setWeekStart(target);
      setSelected(focusDate);
    }
  }

  const days = useMemo(() => Array.from({ length: 6 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const today = isoDate(new Date());

  const { open, close, placed } = useMemo(() => {
    if (!data) return { open: 540, close: 1200, placed: [] as Placed[] };
    const spans = data.dentists.flatMap((d) => Object.values(d.schedule));
    const open = Math.min(...spans.map(([a]) => toMinutes(a)), 540);
    const close = Math.max(...spans.map(([, b]) => toMinutes(b)), 1080);
    const placed = data.appointments.map((a) => {
      const s = clinicParts(a.starts_at, data.timezone);
      const e = clinicParts(a.ends_at, data.timezone);
      return { ...a, date: s.date, start: s.minutes, end: e.minutes };
    });
    return { open, close, placed };
  }, [data]);

  const span = close - open;
  const pct = (m: number) => `${((m - open) / span) * 100}%`;
  const selectedDay = selected && days.some((d) => isoDate(d) === selected) ? selected : null;
  const dayList = selectedDay ? placed.filter((a) => a.date === selectedDay).sort((a, b) => a.start - b.start) : [];

  return (
    <section aria-label="Live calendar" className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="flex items-center gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Live calendar</h2>
          <p className="text-xs text-muted-foreground">
            {RANGE_FMT.format(days[0])} – {RANGE_FMT.format(days[5])}
            {live && (
              <span className="ml-1.5 inline-flex items-center gap-1 text-success">
                <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden /> live
              </span>
            )}
          </p>
        </div>
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Previous week" onClick={() => setWeekStart((w) => addDays(w, -7))}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next week" onClick={() => setWeekStart((w) => addDays(w, 7))}>
            <ChevronRight />
          </Button>
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {!data ? (
        <Skeleton className="h-[360px] w-full rounded-2xl" />
      ) : (
        <div className="brick-soft rounded-2xl bg-card p-2.5">
          <div className="grid grid-cols-[3.25rem_repeat(6,minmax(0,1fr))] gap-1">
            <span />
            {days.map((d) => {
              const iso = isoDate(d);
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => setSelected(iso === selectedDay ? null : iso)}
                  aria-pressed={iso === selectedDay}
                  aria-label={`${DAY_FMT.format(d)} ${d.getDate()}: list appointments`}
                  className={cn(
                    "rounded-lg py-1 text-center text-[0.7rem] leading-tight font-medium transition-colors hover:bg-accent",
                    iso === today && "font-bold text-primary",
                    iso === selectedDay && "bg-primary/10 text-primary",
                  )}
                >
                  {DAY_FMT.format(d)}
                  <span className="block text-xs">{d.getDate()}</span>
                </button>
              );
            })}

            {data.dentists.map((dent) => (
              <DentistRow
                key={dent.id}
                name={dent.short}
                specialty={dent.specialty}
                days={days}
                schedule={dent.schedule}
                lunch={data.lunch}
                appts={placed.filter((a) => a.dentist_id === dent.id)}
                open={open}
                pct={pct}
                fresh={fresh}
                reduce={Boolean(reduce)}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between px-1 text-[0.65rem] text-muted-foreground" aria-hidden>
            <span>{fmtTime(open)} at top</span>
            <span>{fmtTime(close)} at bottom</span>
          </div>
        </div>
      )}

      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[0.7rem] text-muted-foreground" aria-label="Legend">
        <li className="flex items-center gap-1">
          <span className="size-2.5 rounded-[3px] bg-primary" aria-hidden /> booked by Pearl
        </li>
        <li className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-chart-2/60" aria-hidden /> other bookings
        </li>
        <li className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-muted-foreground/35" aria-hidden /> demo fixture
        </li>
        <li className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-[repeating-linear-gradient(45deg,var(--muted)_0_2px,transparent_2px_4px)] ring-1 ring-border" aria-hidden /> off / lunch
        </li>
      </ul>

      {selectedDay && (
        <div className="brick-soft rounded-xl bg-card p-3" aria-live="polite">
          <h3 className="mb-2 text-xs font-semibold">
            {new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short" }).format(new Date(`${selectedDay}T12:00:00`))}
          </h3>
          {dayList.length === 0 ? (
            <p className="text-xs text-muted-foreground">No appointments.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {dayList.map((a) => (
                <li key={a.id} className={cn("flex gap-2", fresh.has(a.id) && "font-medium text-primary")}>
                  <span className="w-28 shrink-0 tabular-nums text-muted-foreground">
                    {fmtTime(a.start)}–{fmtTime(a.end)}
                  </span>
                  <span className="min-w-0">
                    {a.appointment_name} · {a.dentist_name.replace(/^Dr\.\s*(\S+).*/, "Dr. $1")} · {a.patient_display}
                    {a.is_fixture ? " (fixture)" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function DentistRow({
  name,
  specialty,
  days,
  schedule,
  lunch,
  appts,
  open,
  pct,
  fresh,
  reduce,
}: {
  name: string;
  specialty: string;
  days: Date[];
  schedule: Record<string, [string, string]>;
  lunch: [string, string];
  appts: Placed[];
  open: number;
  pct: (m: number) => string;
  fresh: Set<string>;
  reduce: boolean;
}) {
  return (
    <>
      <div className="flex flex-col justify-center pr-1 text-[0.7rem] leading-tight">
        <span className="font-medium">{name.replace(/^Dr\.\s*/, "")}</span>
        <span className="truncate text-muted-foreground">{specialty === "general" ? "general" : specialty.replace(/ist$/, ".")}</span>
      </div>
      {days.map((d) => {
        const iso = isoDate(d);
        const hours = schedule[String(d.getDay())];
        const dayAppts = appts.filter((a) => a.date === iso);
        return (
          <div
            key={iso}
            className="relative h-28 overflow-hidden rounded-lg bg-[repeating-linear-gradient(45deg,var(--muted)_0_3px,transparent_3px_7px)] ring-1 ring-border"
            title={hours ? `${name}: ${hours[0]}–${hours[1]}` : `${name} is off`}
          >
            {hours && (
              <>
                <div className="absolute inset-x-0 bg-card" style={{ top: pct(toMinutes(hours[0])), bottom: `calc(100% - ${pct(toMinutes(hours[1]))})` }} />
                {toMinutes(lunch[0]) >= toMinutes(hours[0]) && toMinutes(lunch[1]) <= toMinutes(hours[1]) && (
                  <div
                    className="absolute inset-x-0 bg-[repeating-linear-gradient(45deg,var(--muted)_0_3px,transparent_3px_7px)]"
                    style={{ top: pct(toMinutes(lunch[0])), height: `calc(${pct(toMinutes(lunch[1]))} - ${pct(toMinutes(lunch[0]))})` }}
                  />
                )}
              </>
            )}
            <AnimatePresence>
              {dayAppts.map((a) => {
                const byPearl = a.source === "voice" || a.source === "chat";
                const isFresh = fresh.has(a.id);
                return (
                  <motion.div
                    key={a.id}
                    data-testid={byPearl ? "appt-pearl" : "appt"}
                    // A new booking drops in and snaps into place like a brick clicking onto a baseplate.
                    initial={reduce ? false : { opacity: 0, y: -14, scaleY: 1.25 }}
                    animate={{ opacity: 1, y: 0, scaleY: 1 }}
                    exit={{ opacity: 0, scale: 0.6 }}
                    transition={{ type: "spring", stiffness: 700, damping: 18 }}
                    className={cn(
                      "absolute inset-x-0.5 rounded-[4px]",
                      byPearl ? "bg-primary" : a.is_fixture ? "bg-muted-foreground/35" : "bg-chart-2/60",
                      isFresh && "z-10 ring-2 ring-primary ring-offset-1 ring-offset-card",
                    )}
                    style={{ top: pct(Math.max(a.start, open)), height: `max(3px, calc(${pct(a.end)} - ${pct(Math.max(a.start, open))} - 1px))` }}
                    title={`${a.appointment_name} · ${fmtTime(a.start)}–${fmtTime(a.end)} · ${a.patient_display}${a.is_fixture ? " (demo fixture)" : ""}`}
                  >
                    {isFresh && !reduce && (
                      <motion.span
                        className="absolute inset-0 rounded-[3px] bg-primary"
                        initial={{ opacity: 0.8, scale: 1 }}
                        animate={{ opacity: 0, scale: 1.8 }}
                        transition={{ duration: 1.2, repeat: 2 }}
                        aria-hidden
                      />
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        );
      })}
    </>
  );
}
