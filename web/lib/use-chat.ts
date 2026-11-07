"use client";

import { type Dispatch, useCallback, useState } from "react";

import { streamChat } from "./chat";
import { type TalkAction, chatLatency } from "./talk";

interface Options {
  dispatch: Dispatch<TalkAction>;
  persona: string;
  conversationId: string | null;
}

/** Text chat with Pearl over SSE, feeding the shared talk reducer. */
export function useChat({ dispatch, persona, conversationId }: Options) {
  const [busy, setBusy] = useState(false);
  // Deliberately no abort-on-unmount: React StrictMode remounts effects in dev, which would cancel a just-sent
  // message (e.g. the landing page's "things to try" chip). A late reply to an unmounted page is a harmless no-op.

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;
      setBusy(true);
      dispatch({ type: "user", channel: "chat", text: message });
      dispatch({ type: "assistant_start", channel: "chat" });
      let tools = 0;
      try {
        await streamChat(
          { message, conversation_id: conversationId, persona },
          (e) => {
            switch (e.type) {
              case "conversation":
                dispatch({ type: "conversation", id: e.conversation_id });
                break;
              case "token":
                dispatch({ type: "token", text: e.text });
                break;
              case "retract":
                dispatch({ type: "retract", reason: e.reason, times: e.times });
                break;
              case "tool_call":
                tools += 1;
                dispatch({ type: "tool_call", channel: "chat", id: e.id, name: e.name, args: e.args, auto: e.auto });
                break;
              case "tool_result":
                dispatch({ type: "tool_result", channel: "chat", id: e.id, name: e.name, result: e.result, ms: e.ms });
                break;
              case "safety":
                dispatch({ type: "safety", channel: "chat", rules: e.rules });
                break;
              case "error":
                dispatch({ type: "error", channel: "chat", message: e.message });
                break;
              case "done":
                dispatch({ type: "latency", row: chatLatency(e.timings ?? {}, tools) });
                break;
            }
          },
        );
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          dispatch({ type: "error", channel: "chat", message: (err as Error).message || "Pearl couldn't reply. Is the agent running?" });
        }
      } finally {
        dispatch({ type: "assistant_done", channel: "chat" });
        setBusy(false);
      }
    },
    [busy, dispatch, persona, conversationId],
  );

  return { busy, send };
}
