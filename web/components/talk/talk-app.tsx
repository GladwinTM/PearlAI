"use client";

import { CalendarDays, MessageSquare, Mic, PanelRightClose, PanelRightOpen, RotateCcw, ScanSearch } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";

import { useHealth } from "@/components/boot/health-provider";
import { WeekCalendar } from "@/components/calendar/week-calendar";
import { Inspector } from "@/components/inspector/inspector";
import type { ToothExpression } from "@/components/pearl/tooth";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { resetDemo } from "@/lib/chat";
import { initialTalk, talkReducer } from "@/lib/talk";
import { useChat } from "@/lib/use-chat";
import { usePersona } from "@/lib/use-persona";
import { prewarmBrowserVoice, useBrowserVoice } from "@/lib/use-browser-voice";
import { useVoice } from "@/lib/use-voice";
import { BACKEND } from "@/lib/config";
import { cn } from "@/lib/utils";

import { Composer } from "./composer";
import { PersonaSwitcher } from "./persona-switcher";
import { Transcript } from "./transcript";
import { TryChips } from "./try-chips";
import { VoiceStage } from "./voice-stage";

type Mode = "voice" | "chat";
type MobilePane = "talk" | "calendar" | "inspector";

const WRITE_TOOLS = new Set(["book_appointment", "reschedule_appointment", "cancel_appointment"]);
const THANKS = /\b(thanks|thank you|thank u|thx|bye|goodbye|good bye|see you)\b/i;
const EXPRESSION_MS = 2600;

export function TalkApp() {
  const params = useSearchParams();
  const router = useRouter();
  const { health } = useHealth();
  const [persona, setPersona] = usePersona();
  const [state, dispatch] = useReducer(talkReducer, undefined, initialTalk);
  // The URL is the source of truth for the mode (?mode=voice | chat): links, the toggle and back/forward all agree,
  // even when Next keeps this page alive between visits.
  const mode: Mode = params.get("mode") === "chat" ? "chat" : "voice";
  const [explaining, setExplaining] = useState(params.get("mode") === "voice");
  const [prevMode, setPrevMode] = useState<Mode>(mode);
  if (mode !== prevMode) {
    // Arrived on a different mode (a link or the toggle): show the mic explainer for voice, nothing for chat.
    setPrevMode(mode);
    setExplaining(mode === "voice");
  }
  const [suggestion, setSuggestion] = useState<string | null>(params.get("mode") === "chat" ? null : params.get("prompt"));
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [pane, setPane] = useState<MobilePane>("talk");
  const [calendarKey, setCalendarKey] = useState(0);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  const [recentActivity, setRecentActivity] = useState(0);
  // Pearl's one-off reactions, from events the client already receives. Cleared after a moment.
  const [expression, setExpression] = useState<ToothExpression | null>(null);
  const react = useCallback((e: ToothExpression) => setExpression(e), []);
  useEffect(() => {
    if (!expression) return;
    const t = setTimeout(() => setExpression(null), EXPRESSION_MS);
    return () => clearTimeout(t);
  }, [expression]);

  const chat = useChat({ dispatch, persona, conversationId: state.conversationId });
  // Refs are pulled out by name so the React Compiler can tell them apart from render values.
  // Serverless (default): voice runs in the browser. With NEXT_PUBLIC_AGENT_URL: the Python agent's WebRTC pipeline.
  // Both hooks are always called (rules of hooks); only one is ever started.
  const browserVoice = useBrowserVoice({ dispatch, persona, conversationId: state.conversationId });
  const pipecatVoice = useVoice({ dispatch, persona, conversationId: state.conversationId });
  const { audioRef, localLevel, remoteLevel, ...voice } = BACKEND === "python" ? pipecatVoice : browserVoice;
  const engine = BACKEND === "python" ? "" : browserVoice.engine;
  const waiting = BACKEND === "python" ? false : browserVoice.waiting;
  const live = voice.status === "live" || voice.status === "connecting";

  // A "things to try" chip clicked on the landing page arrives as ?prompt=…: sent once in chat, a suggestion in voice.
  const sentInitial = useRef(false);
  useEffect(() => {
    const prompt = params.get("prompt");
    if (!prompt || sentInitial.current) return;
    sentInitial.current = true;
    if (mode === "chat") void chat.send(prompt);
    router.replace(`/talk?mode=${mode}`, { scroll: false });
  }, [params, mode, chat, router]);

  // While the mic explainer is up, warm the in-browser VAD so the call starts faster.
  useEffect(() => {
    if (explaining && BACKEND === "serverless") prewarmBrowserVoice();
  }, [explaining]);

  // Outcomes → toast, calendar refresh and jump to the booked week.
  const seen = useRef(0);
  useEffect(() => {
    const fresh = state.timeline.slice(seen.current);
    seen.current = state.timeline.length;
    for (const it of fresh) {
      if (it.kind === "outcome") toast.success(it.title);
      if (it.kind === "safety") {
        toast.warning("Urgent symptoms detected: Pearl is escalating to the clinic team.");
        react("worried");
      }
      if (it.kind === "tool_result" && it.ok && it.tool === "book_appointment") react("wink");
      if (it.kind === "tool_result" && it.tool === "escalate_to_human" && (it.json as { urgency?: string } | undefined)?.urgency === "urgent") react("worried");
      if (it.kind === "tool_result" && it.ok && it.tool && WRITE_TOOLS.has(it.tool)) {
        setCalendarKey((k) => k + 1);
        const start = (it.json as { start?: string } | undefined)?.start;
        if (start) setFocusDate(start.slice(0, 10));
      }
    }
    if (fresh.length) setRecentActivity(Date.now());
  }, [state.timeline, react]);

  // "Thanks" / "bye" from the caller → Pearl holds up a heart.
  const seenMessages = useRef(0);
  useEffect(() => {
    const fresh = state.messages.slice(seenMessages.current);
    seenMessages.current = state.messages.length;
    for (const m of fresh) {
      const text = m.parts[0]?.kind === "text" ? m.parts[0].text : "";
      if (m.role === "user" && THANKS.test(text)) react("heart");
    }
  }, [state.messages, react]);

  // Poll the calendar fast while something is happening (a call, a reply in flight, or activity in the last 30 s).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const calendarLive = live || chat.busy || now - recentActivity < 30000;

  const newConversation = useCallback(() => {
    dispatch({ type: "reset" });
    setFocusDate(null);
  }, []);

  const onPersona = (id: string) => {
    if (id === persona) return;
    setPersona(id);
    newConversation();
  };

  const switchMode = async (next: Mode) => {
    if (next === mode) return;
    if (next === "chat" && voice.status === "live") await voice.end();
    router.replace(`/talk?mode=${next}`, { scroll: false });
    setSuggestion(null);
    if (state.conversationId) dispatch({ type: "info", channel: next, text: `Switched to ${next}: same conversation` });
  };

  const onChip = (prompt: string) => {
    if (mode === "chat") void chat.send(prompt);
    else setSuggestion(prompt);
  };

  const onReset = async () => {
    try {
      if (voice.status === "live") await voice.end();
      await resetDemo();
      newConversation();
      setCalendarKey((k) => k + 1);
      toast.success("Demo reset: calendar fixtures rebuilt and test bookings cleared.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const empty = (
    <div className="mx-auto flex max-w-lg flex-col gap-4 py-6">
      <p className="text-center text-sm text-muted-foreground">
        {mode === "chat"
          ? "Ask Pearl to book, move or cancel an appointment, or ask about the clinic."
          : "Captions appear here while you talk."}
      </p>
      {mode === "chat" && <TryChips onPick={onChip} disabled={chat.busy} />}
    </div>
  );

  return (
    <div className="flex h-dvh flex-col">
      <SiteHeader>
        {health?.demo_mode && (
          <Button variant="ghost" size="sm" onClick={onReset} title="Rebuild demo fixtures and clear test bookings">
            <RotateCcw /> <span className="hidden sm:inline">Reset demo</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="hidden lg:inline-flex"
          onClick={() => setInspectorOpen((o) => !o)}
          aria-pressed={inspectorOpen}
          aria-label={inspectorOpen ? "Hide the Inspector" : "Show the Inspector"}
        >
          {inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </Button>
      </SiteHeader>

      {/* mobile pane switcher */}
      <nav aria-label="Panels" className="flex gap-1.5 overflow-x-auto border-b px-3 py-2 lg:hidden">
        {(
          [
            ["talk", "Talk", mode === "voice" ? Mic : MessageSquare],
            ["calendar", "Calendar", CalendarDays],
            ["inspector", "How it works", ScanSearch],
          ] as const
        ).map(([id, label, Icon]) => (
          <Button key={id} variant={pane === id ? "secondary" : "ghost"} size="sm" className="shrink-0" aria-pressed={pane === id} onClick={() => setPane(id)}>
            <Icon /> {label}
          </Button>
        ))}
      </nav>

      <main
        className={cn(
          // One row, exactly the screen height: only the panels inside scroll, never the page.
          "mx-auto grid min-h-0 w-full max-w-[1600px] flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] gap-4 p-3 lg:p-4",
          inspectorOpen ? "lg:grid-cols-[minmax(300px,340px)_minmax(0,1fr)_minmax(320px,400px)]" : "lg:grid-cols-[minmax(300px,340px)_minmax(0,1fr)]",
        )}
      >
        <aside className={cn("min-h-0 overflow-y-auto", pane === "calendar" ? "block" : "hidden", "lg:block")}>
          <WeekCalendar live={calendarLive} refreshKey={calendarKey} focusDate={focusDate} />
        </aside>

        <section aria-label="Conversation with Pearl" className={cn("min-h-0 flex-col gap-3", pane === "talk" ? "flex" : "hidden", "lg:flex")}>
          <h1 className="sr-only">Talk to Pearl</h1>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <PersonaSwitcher value={persona} onChange={onPersona} disabled={live || chat.busy} compact className="min-w-0 flex-1" />
            <div role="tablist" aria-label="Voice or chat" className="flex shrink-0 rounded-lg bg-muted p-1">
              {(["voice", "chat"] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  type="button"
                  aria-selected={mode === m}
                  data-testid={`mode-${m}`}
                  onClick={() => void switchMode(m)}
                  className={cn(
                    "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-colors sm:flex-none",
                    mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m === "voice" ? <Mic className="size-3.5" aria-hidden /> : <MessageSquare className="size-3.5" aria-hidden />}
                  {m === "voice" ? "Voice" : "Chat"}
                </button>
              ))}
            </div>
          </div>

          {/* Scrolls as a whole if its content is taller than the screen (phones), so nothing is clipped. */}
          <div className="brick-soft flex min-h-0 flex-1 flex-col overflow-y-auto rounded-2xl bg-card p-3">
            {mode === "voice" && (
              <div className="shrink-0 pb-2">
                <VoiceStage
                  status={voice.status}
                  orb={voice.orb}
                  level={voice.orb === "speaking" ? remoteLevel : localLevel}
                  seconds={voice.seconds}
                  maxSeconds={voice.maxSeconds}
                  explaining={explaining}
                  error={voice.error}
                  audioBlocked={voice.audioBlocked}
                  engine={engine}
                  waiting={waiting}
                  expression={expression}
                  suggestion={suggestion}
                  onExplain={() => setExplaining(true)}
                  onCancelExplain={() => setExplaining(false)}
                  onStart={() => {
                    setExplaining(false);
                    void voice.start();
                  }}
                  onEnd={() => void voice.end()}
                  onEnableAudio={voice.enableAudio}
                  onSwitchToChat={() => void switchMode("chat")}
                  onDismissSuggestion={() => setSuggestion(null)}
                />
              </div>
            )}
            <Transcript messages={state.messages} empty={empty} className="min-h-40 flex-1" />
            {mode === "voice" && !live && state.messages.length === 0 && (
              <TryChips onPick={onChip} label="Things to try saying" className="mt-2" />
            )}
            {mode === "chat" && (
              <div className="mt-2 shrink-0 space-y-2">
                {state.messages.length > 0 && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-xs text-muted-foreground">Things to try</summary>
                    <TryChips onPick={onChip} disabled={chat.busy} label="" className="mt-2" />
                  </details>
                )}
                <Composer onSend={(t) => void chat.send(t)} busy={chat.busy} expression={expression} />
              </div>
            )}
          </div>
          {/* Pearl's voice; captions above are the accessible alternative. */}
          <audio ref={audioRef} autoPlay className="hidden" />
        </section>

        <aside
          aria-label="Inspector"
          className={cn("min-h-0 flex-col", pane === "inspector" ? "flex" : "hidden", inspectorOpen ? "lg:flex" : "lg:hidden")}
        >
          <h2 className="mb-2 text-sm font-semibold">See how it works</h2>
          <Inspector timeline={state.timeline} latencies={state.latencies} className="flex-1" />
        </aside>
      </main>
    </div>
  );
}
