import { loadConversation, runTurn } from "@/lib/agent/core";
import { jsonError, rateLimited } from "@/lib/agent/http";
import { PERSONA_PHONES } from "@/lib/agent/personas";
import { settings } from "@/lib/agent/config";

// POST /api/chat → Server-Sent Events: conversation, token, tool_call, tool_result, safety, retract, done, error.
// Same contract as the Python agent, so the UI works with either backend.
export const maxDuration = 60;

export async function POST(req: Request) {
  const limited = rateLimited(req, "chat");
  if (limited) return limited;
  let body: { message?: unknown; conversation_id?: unknown; persona?: unknown; channel?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON.");
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return jsonError(400, "message is required.");
  if (message.length > 1000) return jsonError(400, "message is too long (max 1000 characters).");
  const persona = settings().demoMode && typeof body.persona === "string" ? body.persona : null;
  if (persona && !(persona in PERSONA_PHONES)) return jsonError(400, `Unknown persona '${persona}'.`);
  const channel = body.channel === "voice" ? "voice" : "chat";
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : null;

  const encoder = new TextEncoder();
  const send = (event: string, data: Record<string, unknown>) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);

  // If the browser stops listening (barge-in, hang-up), the turn still runs to completion and is saved: the
  // conversation must never lose a request the caller already made.
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: Record<string, unknown>) => {
        if (!open) return;
        try {
          controller.enqueue(send(event, data));
        } catch {
          open = false;
        }
      };
      try {
        const conv = await loadConversation(conversationId, persona, channel);
        emit("conversation", { conversation_id: conv.id, persona: conv.persona, prompt_version: conv.promptVersion });
        for await (const ev of runTurn(conv, message)) {
          const { type, ...data } = ev;
          emit(type, data);
        }
      } catch (e) {
        console.error("chat turn failed", e);
        emit("error", { message: "Something went wrong on Pearl's side. Please try again." });
        emit("done", { text: "", outcome: null, tools_called: [], timings: {} });
      } finally {
        if (open) {
          open = false;
          controller.close();
        }
      }
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}
