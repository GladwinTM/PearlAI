import { describe, expect, it } from "vitest";

import { isEcho } from "./use-browser-voice";
import { speakableNumbers } from "./voice-text";

describe("browser voice turn-taking", () => {
  const said = ["One moment, let me check.", "Hi Ravi, is this you on the number ending 0 0 0 1?"];

  it("treats Pearl's own words picked up by the mic as echo", () => {
    expect(isEcho("One moment, let me check", said)).toBe(true);
    expect(isEcho("let me check", said)).toBe(true);
    expect(isEcho("", said)).toBe(true);
  });

  it("lets the caller's real words through, even if they reuse a few of Pearl's words", () => {
    expect(isEcho("Yes, that's me. I need a cleaning next Monday", said)).toBe(false);
    expect(isEcho("No, my number is 98000 00002", said)).toBe(false);
  });

  it("speaks phone numbers digit by digit", () => {
    expect(speakableNumbers("Is your number 98000 00001?")).toBe("Is your number 9 8 0 0 0, 0 0 0 0 1?");
  });
});
