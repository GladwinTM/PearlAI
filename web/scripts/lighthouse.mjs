// Lighthouse accessibility (and friends) for the landing page, using Playwright's Chromium.
//   npm run lighthouse                      # against http://localhost:3000/
//   LH_URL=http://localhost:3100/ npm run lighthouse
import { chromium } from "@playwright/test";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";

const url = process.env.LH_URL ?? "http://localhost:3000/";
const chrome = await chromeLauncher.launch({
  chromePath: chromium.executablePath(),
  chromeFlags: ["--headless=new", "--no-sandbox"],
});
try {
  const result = await lighthouse(url, {
    port: chrome.port,
    output: "json",
    logLevel: "error",
    onlyCategories: ["accessibility", "best-practices", "seo"],
  });
  const lhr = result?.lhr;
  if (!lhr) throw new Error("Lighthouse returned no result");
  for (const [id, cat] of Object.entries(lhr.categories)) console.log(`${id.padEnd(16)} ${Math.round((cat.score ?? 0) * 100)}`);
  const failing = Object.values(lhr.audits).filter((a) => a.score !== null && a.score < 1 && a.scoreDisplayMode === "binary");
  if (failing.length) console.log("\nFailing audits:\n" + failing.map((a) => `- ${a.id}: ${a.title}`).join("\n"));
  const a11y = Math.round((lhr.categories.accessibility.score ?? 0) * 100);
  process.exitCode = a11y >= 90 ? 0 : 1;
} finally {
  await chrome.kill();
}
