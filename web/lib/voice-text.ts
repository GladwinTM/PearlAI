// Text that goes to the browser's TTS (port of agent/src/smiledesk/voice/text.py). Spoken words can't be retracted,
// so these run BEFORE synthesis; captions keep the original text.

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]+/gu;
const MARKDOWN = /(\*\*|\*|__|`+|#{1,6}\s|^\s*[-•]\s+|^\s*\d+\.\s+)/gm;

/** No emoji, markdown or list markers in the voice. */
export function stripForSpeech(text: string): string {
  return text.replace(EMOJI, "").replace(MARKDOWN, "").replace(/[ \t]{2,}/g, " ");
}

// "12:00 PM" → "12 PM", "9:05 am" → "9 oh 5 AM", "2:30 PM" → "2 30 PM", "14:00" → "2 PM". Kokoro otherwise reads
// "12:00" as "twelve zero zero".
const CLOCK = /\b([01]?\d|2[0-3]):([0-5]\d)(?![\d:])(\s*(?:([AaPp])\.\s?[Mm]\.|([AaPp])\s?[Mm])(?![A-Za-z]))?/g;

export function speakableTimes(text: string): string {
  return text.replace(CLOCK, (_m, hStr: string, minute: string, _mer: string, dotted?: string, plain?: string) => {
    let hour = Number(hStr);
    let meridiem = (dotted ?? plain ?? "").toLowerCase() || null;
    if (!meridiem && hour > 12) {
      hour -= 12;
      meridiem = "p";
    } else if (!meridiem && hour === 0) {
      hour = 12;
      meridiem = "a";
    }
    const spoken = minute === "00" ? (meridiem ? `${hour}` : `${hour} o'clock`) : minute.startsWith("0") ? `${hour} oh ${minute[1]}` : `${hour} ${minute}`;
    return meridiem ? `${spoken} ${meridiem.toUpperCase()}M` : spoken;
  });
}

// Phone numbers digit by digit: TTS otherwise reads "9800000001" as "nine billion…". Groups (as written, else 5+5)
// become short pauses. Short codes with a leading zero ("ending 0001") are spelled out too.
const PHONE = /\+?\d[\d\s-]{5,}\d/g;
const LEADING_ZERO = /\b0\d{2,5}\b/g;
const spell = (digits: string) => digits.split("").join(" ");

export function speakableNumbers(text: string): string {
  return text
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, "");
      if (digits.length < 7 || /^\s*\d{4}-\d{2}-\d{2}\s*$/.test(m)) return m; // not ISO dates
      const lead = m.match(/^\s*/)?.[0] ?? "";
      const trail = m.match(/\s*$/)?.[0] ?? "";
      let rest = m.trim();
      let prefix = "";
      if (rest.startsWith("+") && digits.length === 12 && digits.startsWith("91")) {
        prefix = "plus 9 1, ";
        rest = rest.replace(/^\+\s*9\s*1[\s-]*/, "");
      } else if (rest.startsWith("+")) {
        prefix = "plus ";
        rest = rest.slice(1);
      }
      let groups = rest.split(/[\s-]+/).filter(Boolean);
      if (groups.length === 1) {
        const d = groups[0];
        groups = d.length === 10 ? [d.slice(0, 5), d.slice(5)] : (d.match(/.{1,3}/g) ?? [d]);
      }
      return lead + prefix + groups.map(spell).join(", ") + trail;
    })
    .replace(LEADING_ZERO, (m) => spell(m));
}

// A claim that the CALLER's appointment changed. "Dr. Priya is fully booked" is an availability fact, not a claim.
const CLAIM =
  /\b(i'?ve|i have|we'?ve|we have|you'?re|you are|your\b[^.?!]{0,60}?\b(?:is|has been|are|was)|that'?s|it'?s|all set)\b[^.?!]{0,60}?\b(booked|confirmed|cancel+ed|rescheduled|moved)\b/i;
const NOT_A_CLAIM = /\b(fully booked|booked up|already booked by|is booked (?:on|for) (?:that|the whole))\b/i;
export const SAFE_REPLACEMENT = "Shall I go ahead and confirm that for you?";

export const isActionClaim = (s: string) => CLAIM.test(s) && !NOT_A_CLAIM.test(s);

/** Everything a sentence goes through before it is spoken. */
export function forSpeech(sentence: string, wroteRecently: boolean): { text: string; blocked: boolean } {
  if (isActionClaim(sentence) && !wroteRecently) return { text: SAFE_REPLACEMENT, blocked: true };
  return { text: speakableTimes(speakableNumbers(stripForSpeech(sentence))).trim(), blocked: false };
}

/**
 * Splits streamed text into speakable chunks: sentences, except the FIRST chunk of a reply may end at a comma
 * (≥ 4 words, never inside a number) so speech starts while the model is still writing.
 */
export class ChunkSplitter {
  private buf = "";
  private emitted = false;

  push(text: string): string[] {
    const out: string[] = [];
    for (const ch of text) {
      this.buf += ch;
      if (!this.emitted && ch === ",") {
        const prev = this.buf.at(-2) ?? "";
        if (!/\d/.test(prev) && this.buf.trim().split(/\s+/).length >= 4) out.push(this.take());
        continue;
      }
      if (ch === "\n" && this.buf.trim()) out.push(this.take());
      else if (/[.!?]/.test(ch)) {
        // Wait for the next char to decide (decimals, "Dr.", ellipses); handled when whitespace arrives.
      } else if (/\s/.test(ch) && /[.!?]["')\]]?\s$/.test(this.buf) && !/\b(Dr|Mr|Mrs|Ms|St)\.\s$/.test(this.buf))
        out.push(this.take());
    }
    return out.filter(Boolean);
  }

  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    this.emitted = false;
    return rest || null;
  }

  private take(): string {
    const s = this.buf.trim();
    this.buf = "";
    this.emitted = true;
    return s;
  }
}
