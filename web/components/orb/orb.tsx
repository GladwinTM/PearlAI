"use client";

import { type RefObject, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

export type OrbMode = "idle" | "listening" | "thinking" | "speaking";

interface OrbProps {
  mode?: OrbMode;
  /** 0..1 audio level, written by the voice client (mic while listening, Pearl's voice while speaking). */
  level?: RefObject<number>;
  className?: string;
  label?: string;
}

const LABEL: Record<OrbMode, string> = {
  idle: "Pearl is ready",
  listening: "Pearl is listening",
  thinking: "Pearl is thinking",
  speaking: "Pearl is speaking",
};

function readColors(el: Element) {
  const cs = getComputedStyle(el);
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  return { a: v("--orb-a", "#eefcfa"), b: v("--orb-b", "#7fd8cf"), c: v("--orb-c", "#9ab6ff"), d: v("--orb-d", "#2a9d8f") };
}

function alpha(hex: string, a: number) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}

/**
 * The audio-reactive pearl. Canvas 2D (no WebGL dependency): a lit sphere with iridescent blobs drifting inside.
 * idle → slow breathing · listening → reacts to the mic · thinking → faster swirl + orbiting arc · speaking → reacts to TTS.
 * Pauses when off-screen or the tab is hidden; reduced motion draws a single still frame per state.
 */
export function Orb({ mode = "idle", level, className, label }: OrbProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let colors = readColors(document.documentElement);
    let raf = 0;
    let visible = true;
    let smooth = 0;
    let swirl = 0;
    let last = performance.now();
    let size = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size = el.clientWidth;
      el.width = Math.round(size * dpr);
      el.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      const m = modeRef.current;
      const target = m === "listening" || m === "speaking" ? Math.min(1, (level?.current ?? 0) * 2.2) : 0;
      smooth += (target - smooth) * Math.min(1, dt * (target > smooth ? 18 : 6));
      swirl += dt * (m === "thinking" ? 1.8 : m === "speaking" ? 0.7 : 0.35);

      const c = size / 2;
      const breathe = reduce.matches ? 0 : Math.sin(t * 1.1) * 0.012;
      const r = size * 0.3 * (1 + breathe + smooth * 0.1);
      ctx.clearRect(0, 0, size, size);

      // halo
      const halo = ctx.createRadialGradient(c, c, r * 0.6, c, c, r * (1.65 + smooth * 0.35));
      halo.addColorStop(0, alpha(colors.b, 0.35 + smooth * 0.25));
      halo.addColorStop(1, alpha(colors.b, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);

      // body
      ctx.save();
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.clip();
      const body = ctx.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.05, c, c, r * 1.05);
      body.addColorStop(0, colors.a);
      body.addColorStop(0.55, colors.b);
      body.addColorStop(1, colors.d);
      ctx.fillStyle = body;
      ctx.fillRect(c - r, c - r, r * 2, r * 2);

      // iridescent blobs drifting inside the pearl
      ctx.globalCompositeOperation = "screen";
      const blobs: [string, number, number, number][] = [
        [colors.c, 0.55, 0.0, 0.55],
        [colors.a, 0.45, 2.1, 0.5],
        [colors.b, 0.6, 4.2, 0.45],
      ];
      for (const [col, orbit, phase, br] of blobs) {
        const ang = swirl + phase;
        const wob = 1 + Math.sin(t * 0.9 + phase) * 0.08;
        const bx = c + Math.cos(ang) * r * orbit * 0.6 * wob;
        const by = c + Math.sin(ang * 1.3) * r * orbit * 0.5 * wob;
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, r * br * (1 + smooth * 0.4));
        g.addColorStop(0, alpha(col, 0.55 + smooth * 0.3));
        g.addColorStop(1, alpha(col, 0));
        ctx.fillStyle = g;
        ctx.fillRect(c - r, c - r, r * 2, r * 2);
      }
      ctx.globalCompositeOperation = "source-over";

      // specular highlight + rim
      const spec = ctx.createRadialGradient(c - r * 0.38, c - r * 0.45, 0, c - r * 0.38, c - r * 0.45, r * 0.45);
      spec.addColorStop(0, "rgba(255,255,255,0.85)");
      spec.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = spec;
      ctx.fillRect(c - r, c - r, r * 2, r * 2);
      ctx.restore();

      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // thinking: an arc orbiting the pearl
      if (m === "thinking") {
        ctx.beginPath();
        ctx.arc(c, c, r * 1.22, swirl * 1.6, swirl * 1.6 + Math.PI * 0.6);
        ctx.strokeStyle = alpha(colors.b, 0.8);
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    };

    const loop = (now: number) => {
      draw(now);
      if (visible && !document.hidden && !reduce.matches) raf = requestAnimationFrame(loop);
    };
    const kick = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };

    resize();
    kick();

    const ro = new ResizeObserver(() => {
      resize();
      kick();
    });
    ro.observe(el);
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) kick();
    });
    io.observe(el);
    const mo = new MutationObserver(() => {
      colors = readColors(document.documentElement);
      kick();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    document.addEventListener("visibilitychange", kick);
    reduce.addEventListener("change", kick);
    // Reduced motion: redraw a still frame when the mode changes.
    const modeTimer = setInterval(() => {
      if (reduce.matches) draw(performance.now());
    }, 500);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(modeTimer);
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      document.removeEventListener("visibilitychange", kick);
      reduce.removeEventListener("change", kick);
    };
  }, [level]);

  return <canvas ref={canvas} role="img" aria-label={label ?? LABEL[mode]} className={cn("aspect-square w-full", className)} />;
}
