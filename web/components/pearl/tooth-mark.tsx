import { useId } from "react";

import { cn } from "@/lib/utils";

export type ToothFace = "smile" | "open" | "wink" | "worried" | "confused" | "up" | "sleepy";

/** Pearl's silhouette: a molar with two cusps and two short roots. viewBox 0 0 100 110. */
export const TOOTH_PATH =
  "M50 15C41 6 22 3 13 14C5 25 7 44 13 58C17 70 17 84 21 96C24 105 36 105 38 95C40 85 44 77 50 77C56 77 60 85 62 95C64 105 76 105 79 96C83 84 83 70 87 58C93 44 95 25 87 14C78 3 59 6 50 15Z";

interface Props {
  face?: ToothFace;
  className?: string;
  /** A navy outline: helps at small sizes (logo, favicon) on light backgrounds. */
  outline?: boolean;
  title?: string;
}

const INK = "var(--tooth-ink, #14121f)";

function Eye({ x, face, side }: { x: number; face: ToothFace; side: "l" | "r" }) {
  const y = 42;
  if (face === "wink" && side === "l") return <path d={`M${x - 6} ${y + 1}Q${x} ${y - 6} ${x + 6} ${y + 1}`} stroke={INK} strokeWidth="2.6" fill="none" strokeLinecap="round" />;
  if (face === "worried") {
    const d = side === "l" ? `M${x - 5} ${y - 5}L${x + 4} ${y}L${x - 5} ${y + 5}` : `M${x + 5} ${y - 5}L${x - 4} ${y}L${x + 5} ${y + 5}`;
    return <path d={d} stroke={INK} strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />;
  }
  if (face === "sleepy") return <path d={`M${x - 6} ${y}Q${x} ${y + 5} ${x + 6} ${y}`} stroke={INK} strokeWidth="2.6" fill="none" strokeLinecap="round" />;
  const dy = face === "up" ? -2.5 : 0;
  const dx = face === "up" ? 1.5 : face === "confused" && side === "r" ? 0 : 0;
  const r = face === "confused" && side === "r" ? 4.2 : 5.2;
  return (
    <g>
      <ellipse cx={x + dx} cy={y + dy} rx={r} ry={r * 1.18} fill={INK} />
      <circle cx={x + dx + r * 0.38} cy={y + dy - r * 0.5} r={r * 0.3} fill="#fff" />
    </g>
  );
}

function Mouth({ face }: { face: ToothFace }) {
  const common = { stroke: INK, strokeWidth: 2.6, fill: "none", strokeLinecap: "round" as const };
  if (face === "open")
    return (
      <g>
        <path d="M42 54Q50 55 58 54Q58 66 50 66Q42 66 42 54Z" fill="var(--tooth-mouth, #3a1530)" />
        <ellipse cx="50" cy="62.5" rx="4.6" ry="2.4" fill="var(--tooth-tongue, #ff8a9a)" />
      </g>
    );
  if (face === "worried") return <path d="M41 57q2.25-3 4.5 0t4.5 0t4.5 0t4.5 0" {...common} />;
  if (face === "confused") return <path d="M43 58Q47 55 50 57.5T57 56" {...common} />;
  if (face === "up") return <path d="M45 56Q50 60 55 56" {...common} />;
  return <path d="M42 54Q50 63 58 54" {...common} />;
}

/** The static tooth: logo, favicon, persona cards and the 3D tooth's poster while it loads. */
export function ToothMark({ face = "smile", className, outline, title }: Props) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 100 110" className={cn("size-8", className)} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <defs>
        <radialGradient id={`${id}-body`} cx="38%" cy="28%" r="78%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.62" stopColor="var(--tooth, #fbfaf7)" />
          <stop offset="1" stopColor="#d9dfee" />
        </radialGradient>
      </defs>
      <path d={TOOTH_PATH} fill={`url(#${id}-body)`} stroke={outline ? INK : "none"} strokeWidth={outline ? 4 : 0} strokeLinejoin="round" />
      <ellipse cx="27" cy="51" rx="6.5" ry="4" fill="var(--tooth-blush, #f4a3d6)" opacity="0.85" />
      <ellipse cx="73" cy="51" rx="6.5" ry="4" fill="var(--tooth-blush, #f4a3d6)" opacity="0.85" />
      <Eye x={35} face={face} side="l" />
      <Eye x={65} face={face} side="r" />
      <Mouth face={face} />
    </svg>
  );
}
