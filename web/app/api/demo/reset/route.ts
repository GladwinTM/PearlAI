import { settings } from "@/lib/agent/config";
import { db, rows } from "@/lib/agent/db";
import { jsonError, rateLimited } from "@/lib/agent/http";

// POST /api/demo/reset → rebuild demo fixtures and clear test bookings (DEMO_MODE only).
export async function POST(req: Request) {
  const limited = rateLimited(req, "reset");
  if (limited) return limited;
  if (!settings().demoMode) return jsonError(404, "Not found");
  const result = rows<Record<string, unknown>>(await db().rpc("reset_demo_fixtures", {}))[0] ?? {};
  return Response.json({ ok: true, ...result });
}
