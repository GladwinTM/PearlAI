import { describe, expect, it } from "vitest";

import { isActionClaim, speakableNumbers, speakableTimes, stripForSpeech } from "../voice-text";
import fixtures from "./__fixtures__/parity.json";
import { dateContext } from "./clock";
import { spokenTimes } from "./grounding";
import { checkMessage } from "./safety";
import { normalizePhone, phonesInText } from "./tools";

// The TypeScript port must produce exactly what the Python agent produces (fixtures: agent/scripts/parity_fixtures.py).
const TZ = "Asia/Kolkata";
const WORKING = { 0: [], 1: ["Arjun", "Priya"], 2: ["Kavya", "Priya"], 3: ["Arjun", "Priya"], 4: ["Kavya", "Priya"], 5: ["Arjun", "Priya"], 6: ["Arjun", "Priya"] };
const instant = (localIso: string) => new Date(`${localIso}+05:30`);

describe("parity with the Python agent", () => {
  it.each(fixtures.date_context)("date table at $now", ({ now, text }) => {
    expect(dateContext(instant(now), TZ, WORKING, new Set(["2026-12-25"]))).toBe(text);
  });
  it.each(fixtures.spoken_times)("spoken times in %#", ({ text, times }) => {
    expect([...spokenTimes(text)].sort()).toEqual(times);
  });
  it.each(fixtures.safety)("safety rules for '$text'", ({ text, rules, breathing, instruction }) => {
    const r = checkMessage(text);
    expect(r.rules).toEqual(rules);
    expect(r.breathingOrSwallowing).toBe(breathing);
    expect(r.instruction).toBe(instruction);
  });
  it.each(fixtures.normalize_phone)("normalize_phone($raw)", ({ raw, e164 }) => {
    expect(normalizePhone(raw)).toBe(e164);
  });
  it.each(fixtures.phones_in_text)("phones in '$text'", ({ text, phones }) => {
    expect([...phonesInText(text)].sort()).toEqual(phones);
  });
  it.each(fixtures.speakable_times)("speakable '$text'", ({ text, spoken }) => {
    expect(speakableTimes(text)).toBe(spoken);
  });
  it.each(fixtures.speakable_numbers)("speakable numbers '$text'", ({ text, spoken }) => {
    expect(speakableNumbers(text)).toBe(spoken);
  });
  it.each(fixtures.strip_for_speech)("strip for speech %#", ({ text, spoken }) => {
    expect(stripForSpeech(text)).toBe(spoken);
  });
  it.each(fixtures.action_claims)("action claim '$text'", ({ text, claim }) => {
    expect(isActionClaim(text)).toBe(claim);
  });
});
