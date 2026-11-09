// Every clock time Pearl says must come from a tool result or the caller (port of agent/grounding.py).

const NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const MIN: Record<string, number> = {
  "o'clock": 0, oclock: 0, fifteen: 15, thirty: 30, "forty five": 45, "forty-five": 45, forty: 40, twenty: 20,
  ten: 10, five: 5,
};
const MER = String.raw`(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])`;
const DIGITS = new RegExp(String.raw`\b(\d{1,2})(?::(\d{2}))?\s*` + MER, "gi");
const WORDS = new RegExp(
  String.raw`\b(` + Object.keys(NUM).join("|") + String.raw`)(?:[\s-]+(o'?clock|fifteen|thirty|forty[\s-]five|forty|twenty|ten|five))?\s+` + MER,
  "gi",
);
const ISO = /T(\d{2}):(\d{2})/g;

function hm(h: number, m: number, mer: string): string | null {
  const pm = mer.toLowerCase().startsWith("p");
  if (h < 1 || h > 12 || m < 0 || m > 59) return null;
  const h24 = (h % 12) + (pm ? 12 : 0);
  return `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Clock times mentioned in text, as 'HH:MM' (24h). */
export function spokenTimes(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(DIGITS)) {
    const t = hm(Number(m[1]), Number(m[2] ?? 0), m[3]);
    if (t) out.add(t);
  }
  for (const m of text.matchAll(WORDS)) {
    const mins = MIN[(m[2] ?? "o'clock").toLowerCase().replaceAll("-", " ")] ?? 0;
    const t = hm(NUM[m[1].toLowerCase()], mins, m[3]);
    if (t) out.add(t);
  }
  return out;
}

/** All times anywhere in a tool result (ISO starts, labels like '9:00 AM', FAQ text like '9 AM'). */
export function timesIn(value: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
    else if (typeof v === "string") {
      spokenTimes(v).forEach((t) => out.add(t));
      for (const m of v.matchAll(ISO)) out.add(`${m[1]}:${m[2]}`);
    }
  };
  walk(value);
  return out;
}

export function ungrounded(text: string, grounded: Iterable<string>): Set<string> {
  const ok = new Set(grounded);
  return new Set([...spokenTimes(text)].filter((t) => !ok.has(t)));
}
