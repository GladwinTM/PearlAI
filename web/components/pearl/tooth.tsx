"use client";

import { useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

import { ToothMark, type ToothFace } from "./tooth-mark";
import { EXPRESSION_LABEL, TOOTH_LABEL, type ToothExpression, type ToothMode } from "./types";

export type { ToothExpression, ToothMode } from "./types";

// three.js loads only when a tooth is on screen, never on the server.
const ToothScene = dynamic(() => import("./tooth-scene"), { ssr: false, loading: () => null });

interface ToothProps {
  mode?: ToothMode;
  /** 0..1 audio level, written by the voice client (mic while listening, Pearl's voice while speaking). */
  level?: RefObject<number>;
  className?: string;
  label?: string;
  /** A one-off reaction (booking confirmed, urgent, thank you). The caller clears it. */
  expression?: ToothExpression | null;
  /** Force the still pose (previews). Reduced motion does this automatically. */
  still?: boolean;
  /** Cap the frame rate (e.g. 30 during a voice call). */
  maxFps?: number;
}

let webglSupport: boolean | null = null;
function hasWebGL(): boolean {
  if (webglSupport === null) {
    try {
      webglSupport = !!document.createElement("canvas").getContext("webgl2");
    } catch {
      webglSupport = false;
    }
  }
  return webglSupport;
}
const noSubscribe = () => () => {};

function posterFace(mode: ToothMode, expression: ToothExpression | null): ToothFace {
  if (expression === "wink") return "wink";
  if (expression === "worried") return "worried";
  if (mode === "thinking") return "up";
  if (mode === "speaking") return "open";
  return "smile";
}

/**
 * Pearl, the 3D clay tooth (replaces the Orb, same API plus `expression`). A static SVG poster shows while three.js
 * loads, when WebGL is missing, and fades out once the first 3D frame is drawn. Pauses off-screen and in hidden tabs.
 */
export function Tooth({ mode = "idle", level, className, label, expression = null, still, maxFps }: ToothProps) {
  const box = useRef<HTMLDivElement>(null);
  const webgl = useSyncExternalStore(noSubscribe, hasWebGL, () => false);
  const reduced = useReducedMotion() ?? false;
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { rootMargin: "100px" });
    io.observe(el);
    const vis = () => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", vis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  return (
    <div ref={box} role="img" aria-label={label ?? (expression ? EXPRESSION_LABEL[expression] : TOOTH_LABEL[mode])} className={cn("relative aspect-square w-full", className)}>
      <ToothMark
        face={posterFace(mode, expression)}
        className={cn("absolute top-[17%] left-[25%] h-[62%] w-[50%] transition-opacity duration-300", ready && "opacity-0")}
      />
      {webgl && (
        <ToothScene mode={mode} expression={expression} level={level} active={onScreen && tabVisible} still={!!still || reduced} maxFps={maxFps} onReady={() => setReady(true)} />
      )}
    </div>
  );
}
