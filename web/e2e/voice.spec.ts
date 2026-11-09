import path from "node:path";

import { chromium, expect, test } from "@playwright/test";

// Real voice, end to end, in the browser (serverless mode): a spoken question played as the microphone →
// in-browser VAD → /api/transcribe (Groq Whisper) → /api/chat → Pearl's spoken answer.
// Opt-in (uses Groq quota and full Chromium): VOICE_E2E=1 npx playwright test e2e/voice.spec.ts
test.skip(!process.env.VOICE_E2E, "set VOICE_E2E=1 to run the browser voice test");

const BOOT = '[role="dialog"][aria-labelledby="boot-title"]';
const QUESTION = path.join(__dirname, "fixtures/question-insurance.wav");

test("spoken question is heard, answered from the FAQ, and spoken back", async ({ baseURL, request }) => {
  test.setTimeout(150_000);
  expect((await request.post("/api/demo/reset")).ok()).toBe(true);
  const browser = await chromium.launch({
    channel: "chromium", // full Chromium: the headless shell has no media capture
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${QUESTION}`],
  });
  const page = await (await browser.newContext({ permissions: ["microphone"], baseURL })).newPage();
  try {
    await page.goto("/talk?mode=voice");
    await expect(page.locator(BOOT)).toHaveCount(0, { timeout: 60_000 });
    await page.getByRole("button", { name: "Allow mic and call" }).click();

    const transcript = page.getByTestId("transcript");
    await expect(transcript).toContainText("Pearl Dental Care", { timeout: 15_000 }); // greeting, immediately
    await expect(transcript).toContainText(/insurance/i, { timeout: 60_000 }); // the caller's words, transcribed
    await expect(transcript).toContainText(/cashless|reimburse|insurer/i, { timeout: 60_000 }); // FAQ-backed answer
    await expect(page.getByTestId("timeline")).toContainText("get_clinic_info");
    await expect(page.getByRole("region", { name: "Latency per turn" }).getByRole("img").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "End call" }).click();
  } finally {
    await browser.close();
  }
});
