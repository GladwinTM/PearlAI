import { connection } from "next/server";

import { loadClinic } from "@/lib/agent/clinic";
import { addDays, localParts, pyWeekday } from "@/lib/agent/clock";
import { settings } from "@/lib/agent/config";
import { db, rows } from "@/lib/agent/db";
import { jsonError } from "@/lib/agent/http";

// GET /api/calendar?from&to → masked appointments for the public calendar (default: current clinic week).
const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && addDays(v, 0) === v;

export async function GET(req: Request) {
  await connection();
  const s = settings();
  const url = new URL(req.url);
  const today = localParts(new Date(), s.clinicTimezone).date;
  const fromQ = url.searchParams.get("from");
  const toQ = url.searchParams.get("to");
  if ((fromQ && !isDate(fromQ)) || (toQ && !isDate(toQ))) return jsonError(400, "Dates must be YYYY-MM-DD.");
  const start = fromQ ?? addDays(today, -pyWeekday(today));
  const end = toQ ?? addDays(start, 6);
  if (end < start) return jsonError(400, "`to` must be on or after `from`.");
  if (Date.parse(end) - Date.parse(start) > 31 * 86_400_000) return jsonError(400, "Range can be at most 31 days.");

  const [appts, clinic] = await Promise.all([db().rpc("get_calendar", { p_from: start, p_to: end }), loadClinic()]);
  return Response.json({
    from: start,
    to: end,
    timezone: s.clinicTimezone,
    dentists: clinic.dentists.map((d) => ({
      id: d.id,
      full_name: d.fullName,
      short: d.short,
      specialty: d.specialty,
      schedule: Object.fromEntries([...d.schedule.entries()].map(([wd, h]) => [String(wd), [h.start, h.end]])),
    })),
    lunch: [clinic.lunch.start, clinic.lunch.end],
    appointments: rows(appts),
  });
}
