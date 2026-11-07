// Public, browser-safe config only. Secrets (e.g. the Supabase service-role key) never live in the web app:
// every data call goes through the agent API.
export const AGENT_URL = (process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:8000").replace(/\/$/, "");

// Optional link shown on the landing page; hidden when unset.
export const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL ?? "";
