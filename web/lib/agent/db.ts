import "server-only";

import { execSync } from "node:child_process";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { settings } from "./config";

let client: SupabaseClient | null = null;

/** Local dev convenience (like the Python agent): read the service-role key from `supabase status`. */
function localServiceKey(): string {
  if (process.env.NODE_ENV === "production") return "";
  try {
    const out = execSync("npx --no-install supabase status -o env", {
      cwd: path.resolve(process.cwd(), ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
    });
    const m = /^SERVICE_ROLE_KEY="?([^"\n]+)"?/m.exec(out);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

/** Service-role Supabase client. Server only: the key never reaches the browser. */
export function db(): SupabaseClient {
  if (client) return client;
  const s = settings();
  const local = /127\.0\.0\.1|localhost/.test(s.supabaseUrl);
  const key = s.supabaseKey || (local ? localServiceKey() : "");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
  client = createClient(s.supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export class DbError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Unwrap a Supabase response: throw DbError on error, return rows. */
export function rows<T = Record<string, unknown>>(res: { data: unknown; error: { message: string; code?: string } | null }): T[] {
  if (res.error) throw new DbError(res.error.message, res.error.code);
  if (res.data == null) return [];
  return (Array.isArray(res.data) ? res.data : [res.data]) as T[];
}
