// Public, browser-safe config only. Secrets (e.g. the Supabase service-role key) never live in the web app:
// every data call goes through the agent API.
// Which backend the web app talks to:
// - unset/empty (default): the serverless agent in this Next.js app (same origin, /api/*), voice in the browser.
// - set (e.g. http://localhost:8000): the Python agent (FastAPI + Pipecat), voice over WebRTC. The full local version.
export const AGENT_URL = (process.env.NEXT_PUBLIC_AGENT_URL || "").replace(/\/$/, "");
export const BACKEND: "serverless" | "python" = AGENT_URL ? "python" : "serverless";

// Optional link shown on the landing page; hidden when unset or empty.
export const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL || "";
