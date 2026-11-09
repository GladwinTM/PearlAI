/** Same states as the old Orb, so callers don't change. */
export type ToothMode = "idle" | "listening" | "thinking" | "speaking";

/** One-off reactions, triggered by events the client already receives. */
export type ToothExpression = "wink" | "worried" | "heart";

export const TOOTH_LABEL: Record<ToothMode, string> = {
  idle: "Pearl is ready",
  listening: "Pearl is listening",
  thinking: "Pearl is thinking",
  speaking: "Pearl is speaking",
};

export const EXPRESSION_LABEL: Record<ToothExpression, string> = {
  wink: "Pearl winks: your booking is confirmed",
  worried: "Pearl looks worried",
  heart: "Pearl holds a heart: thank you",
};
