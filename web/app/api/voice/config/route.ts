import { connection } from "next/server";

import { localParts, localToInstant } from "@/lib/agent/clock";
import { settings } from "@/lib/agent/config";
import { db } from "@/lib/agent/db";

// GET /api/voice/config → how the browser should run voice, and whether today's demo voice quota is used up.
const RESTING = "Pearl is resting for today: the demo's daily voice limit is reached. Chat still works, so give that a try!";

export async function GET() {
  await connection();
  const s = settings();
  let callsToday = 0;
  if (s.maxVoiceCallsPerDay > 0) {
    const today = localParts(new Date(), s.clinicTimezone).date;
    const since = localToInstant(today, 0, 0, s.clinicTimezone).toISOString();
    const res = await db().from("conversations").select("id", { count: "exact", head: true }).eq("channel", "voice").gte("started_at", since);
    callsToday = res.count ?? 0;
  }
  return Response.json({
    transport: "browser",
    max_session_seconds: 240,
    daily_limit_reached: s.maxVoiceCallsPerDay > 0 && callsToday >= s.maxVoiceCallsPerDay,
    resting_message: RESTING,
  });
}
