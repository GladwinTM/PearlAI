import { cn } from "@/lib/utils";

/** The pearl mark: a lit sphere with a soft highlight. Same artwork as app/icon.svg. */
export function PearlMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-7", className)}>
      <defs>
        <radialGradient id="pm-body" cx="38%" cy="34%" r="70%">
          <stop offset="0" stopColor="#f4fffd" />
          <stop offset="0.55" stopColor="#7fd8cf" />
          <stop offset="1" stopColor="#1f7f86" />
        </radialGradient>
        <radialGradient id="pm-sheen" cx="70%" cy="72%" r="45%">
          <stop offset="0" stopColor="#9ab6ff" stopOpacity="0.7" />
          <stop offset="1" stopColor="#9ab6ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="13" fill="url(#pm-body)" />
      <circle cx="16" cy="16" r="13" fill="url(#pm-sheen)" />
      <ellipse cx="11.5" cy="10.5" rx="4" ry="2.6" fill="#fff" opacity="0.85" transform="rotate(-30 11.5 10.5)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <PearlMark />
      <span className="flex flex-col leading-none">
        <span className="font-semibold tracking-tight">SmileDesk</span>
        <span className="text-[0.7rem] text-muted-foreground">Pearl Dental Care</span>
      </span>
    </span>
  );
}
