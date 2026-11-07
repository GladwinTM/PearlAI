// Public, browser-safe config only. Secrets (e.g. the Supabase service-role key) never live in the web app:
// every data call goes through the agent API.
// `||`, not `??`: an empty line in .env (NEXT_PUBLIC_AGENT_URL=) must fall back to the default too.
export const AGENT_URL = (process.env.NEXT_PUBLIC_AGENT_URL || "http://localhost:8000").replace(/\/$/, "");

// Optional link shown on the landing page; hidden when unset or empty.
export const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL || "";
