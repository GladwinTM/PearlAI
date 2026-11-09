import { expect, test } from "@playwright/test";

const BOOT = '[role="dialog"][aria-labelledby="boot-title"]';

test.beforeEach(async ({ request }) => {
  // Start from known demo data so the run is repeatable. Serverless (default): the web app's own API;
  // AGENT_URL=http://localhost:8000 when testing against the Python agent.
  const api = process.env.AGENT_URL ?? "";
  const res = await request.post(`${api}/api/demo/reset`);
  expect(res.ok()).toBe(true);
});

test("landing → chat as a persona → send a chip → tool call shows in the Inspector", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(BOOT)).toHaveCount(0, { timeout: 90_000 }); // boot screen clears once warmup is done
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Meet Pearl");

  await page.getByTestId("persona-ravi").click();
  await expect(page.getByTestId("persona-ravi")).toHaveAttribute("aria-checked", "true");

  const chip = "Book a checkup with Dr. Priya next Thursday";
  await page.getByRole("button", { name: chip }).click();

  await expect(page).toHaveURL(/\/talk/);
  await expect(page.getByTestId("mode-chat")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("transcript")).toContainText(chip);

  // Caller ID triggers an automatic lookup_patient before the model runs; the model then checks availability.
  const timeline = page.getByTestId("timeline");
  await expect(timeline.locator('[data-kind="tool_call"]').first()).toBeVisible();
  await expect(timeline).toContainText("lookup_patient");
  await expect(timeline.locator('[data-kind="tool_result"]').first()).toBeVisible();
  await expect(page.getByTestId("tool-pill").first()).toBeVisible();

  // The reply finishes and a latency bar is recorded.
  await expect(timeline.locator('[data-kind="pearl"]').first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("region", { name: "Latency per turn" }).getByRole("img").first()).toBeVisible();
});

test("404 page links back to Pearl", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("gone for a cleaning");
  await expect(page.getByRole("link", { name: "Talk to Pearl" })).toHaveAttribute("href", "/talk?mode=voice");
});

test("mic explainer appears before the browser prompt, and Not now dismisses it", async ({ page }) => {
  await page.goto("/talk?mode=voice");
  await expect(page.locator(BOOT)).toHaveCount(0, { timeout: 90_000 });
  const explainer = page.getByRole("region", { name: "Microphone permission" });
  await expect(explainer).toBeVisible();
  await explainer.getByRole("button", { name: "Not now" }).click();
  await expect(explainer).toHaveCount(0);
  await expect(page.getByTestId("start-call")).toBeVisible();
});

test("the URL follows the mode: toggle and landing CTAs", async ({ page }) => {
  await page.goto("/talk?mode=chat");
  await expect(page.locator(BOOT)).toHaveCount(0, { timeout: 90_000 });
  await page.getByTestId("mode-voice").click();
  await expect(page).toHaveURL(/\/talk\?mode=voice/);
  await expect(page.getByRole("region", { name: "Microphone permission" })).toBeVisible();
  await page.getByTestId("mode-chat").click();
  await expect(page).toHaveURL(/\/talk\?mode=chat/);

  // Back to the landing page, then "Talk to Pearl": the Talk page (kept alive by Next) must switch to voice.
  await page.goto("/");
  await page.getByTestId("cta-voice").click();
  await expect(page).toHaveURL(/\/talk\?mode=voice/);
  await expect(page.getByTestId("mode-voice")).toHaveAttribute("aria-selected", "true");
  await page.goto("/");
  await page.getByTestId("cta-chat").click();
  await expect(page).toHaveURL(/\/talk\?mode=chat/);
  await expect(page.getByTestId("mode-chat")).toHaveAttribute("aria-selected", "true");
});
