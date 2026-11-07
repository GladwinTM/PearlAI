import { expect, test } from "@playwright/test";

// Acceptance screenshots (desktop + mobile, light + dark). Run with: npm run screenshots
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 (npm run screenshots)");

const OUT = "../docs/screenshots";
const BOOT = '[role="dialog"][aria-labelledby="boot-title"]';
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;

for (const [device, viewport] of Object.entries(VIEWPORTS)) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${device} ${scheme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2, isMobile: device === "mobile", hasTouch: device === "mobile" });
      const page = await ctx.newPage();
      await page.emulateMedia({ reducedMotion: "reduce" }); // still frames, no mid-animation captures

      // Hide the Next.js dev-tools badge if the dev server is the one being captured.
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent = "nextjs-portal{display:none!important}";
          document.head.appendChild(style);
        });
      });
      await page.goto("/");
      await expect(page.locator(BOOT)).toHaveCount(0, { timeout: 90_000 });
      await page.waitForTimeout(1500); // let the entrance fades finish
      await page.screenshot({ path: `${OUT}/landing-${device}-${scheme}.png` });

      await page.goto("/talk?mode=chat");
      await expect(page.locator(BOOT)).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Live calendar" }).or(page.getByRole("tablist", { name: "Voice or chat" })).first()).toBeVisible();
      await page.waitForTimeout(1500);
      // No horizontal overflow on any viewport.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `${OUT}/talk-${device}-${scheme}.png` });
      await ctx.close();
    });
  }
}
