import { AGENT_URL } from "./config";

export type AgentEvent =
  | { type: "conversation"; conversation_id: string; persona: string | null; prompt_version: string }
  | { type: "token"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; auto?: boolean }
  | { type: "tool_result"; id: string; name: string; result: Record<string, unknown>; ms: number }
  | { type: "safety"; rules: string[]; instruction: string }
  | { type: "retract"; text: string; reason: string; times: string[] }
  | { type: "error"; message: string }
  | {
      type: "done";
      text: string;
      outcome: string | null;
      tools_called?: string[];
      timings: { total_ms?: number; ttft_ms?: number | null; llm_ms?: number; tools_ms?: number; rounds?: number };
    };

export interface ChatRequest {
  message: string;
  conversation_id?: string | null;
  persona?: string | null;
}

/** POST /api/chat and parse the Server-Sent Events stream. */
export async function streamChat(req: ChatRequest, onEvent: (e: AgentEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`${AGENT_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (res.status === 429) throw new Error("You're sending messages too quickly. Please wait a moment.");
  if (!res.ok || !res.body) throw new Error(`Chat failed (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const lines = frame.split("\n");
      const eventName = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const data = lines
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      // The SSE `event:` name is authoritative; fall back to it if a payload lacks `type`.
      if (data) onEvent({ type: eventName, ...JSON.parse(data) } as AgentEvent);
    }
  }
}

export async function resetDemo(): Promise<void> {
  const res = await fetch(`${AGENT_URL}/api/demo/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`Reset failed (${res.status})`);
}
