/**
 * Visual smoke tests for the MyMCP dashboard.
 *
 * Takes screenshots at different viewports for manual diffing.
 * Screenshots are regenerated on each run (gitignored).
 *
 * Prerequisites:
 * - A running MyMCP server (npm run dev) or set PLAYWRIGHT_BASE_URL
 * - Chromium installed: npx playwright install chromium
 */
import { test } from "@playwright/test";
import path from "node:path";

const screenshotDir = path.resolve(__dirname, "screenshots");

test("config page — desktop (1280px)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/config");
  // Wait for the page to finish loading
  await page.waitForLoadState("networkidle");
  await page.screenshot({
    path: path.join(screenshotDir, "config-desktop.png"),
    fullPage: true,
  });
});

test("config page — mobile (375px)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/config");
  await page.waitForLoadState("networkidle");
  await page.screenshot({
    path: path.join(screenshotDir, "config-mobile.png"),
    fullPage: true,
  });
});

test("welcome page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/welcome");
  await page.waitForLoadState("networkidle");
  await page.screenshot({
    path: path.join(screenshotDir, "welcome.png"),
    fullPage: true,
  });
});
