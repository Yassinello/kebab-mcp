/**
 * E2E tests for the storage UX v2 — verifies the dashboard reflects the
 * runtime storage mode correctly across the three primary modes.
 *
 * These tests run against a live server and only assert what's currently
 * deployable: the test process can't trivially flip the server into a
 * read-only filesystem, so the static-mode checks are limited to the
 * "I can render the choice card given a mocked status" surface via the
 * /api/storage/status mock.
 *
 * Full coverage of the static branch lives in the unit tests for
 * storage-mode.ts and the route handlers; here we just verify the UI
 * wiring (badge, tab, save-button disabled state) given the JSON shape.
 */
import { test, expect } from "@playwright/test";

const token = process.env.MCP_AUTH_TOKEN || "test-token";

test.describe("storage tab + badge", () => {
  test("storage tab renders current mode and recheck button", async ({ page }) => {
    await page.goto(`/config?tab=storage&token=${token}`);
    await page.waitForLoadState("networkidle");
    // Either KV / File / Static — at least one mode label must appear
    const modeVisible =
      (await page.locator("text=Upstash Redis").count()) > 0 ||
      (await page.locator("text=Filesystem").count()) > 0 ||
      (await page.locator("text=Static").count()) > 0 ||
      (await page.locator("text=KV unreachable").count()) > 0;
    expect(modeVisible).toBe(true);
    await expect(page.getByRole("button", { name: /recheck/i })).toBeVisible();
  });

  test("storage badge is visible in the account menu", async ({ page }) => {
    await page.goto(`/config?token=${token}`);
    await page.waitForLoadState("networkidle");
    // Redesign 2026-11: the badge moved from the sidebar footer to the
    // top-right account chip's panel.
    await page.getByRole("button", { name: /account menu/ }).click();
    // Badge text is one of: KV, File, Static, KV ✗, or … (loading)
    const badge = page.locator("a[href='/config?tab=storage']").first();
    await expect(badge).toBeVisible();
  });

  test("connectors tab renders the env-stub helper when in static mode", async ({ page }) => {
    // Intercept /api/storage/status to force static mode
    await page.route("**/api/storage/status*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mode: "static",
          reason: "Mocked static for test",
          dataDir: "/tmp",
          kvUrl: null,
          latencyMs: null,
          error: "EROFS",
          detectedAt: new Date().toISOString(),
          counts: null,
        }),
      });
    });

    await page.goto(`/config?tab=connectors&token=${token}`);
    await page.waitForLoadState("networkidle");
    // Expand the first connector card
    const firstCard = page.locator("[role='button']").first();
    await firstCard.click();
    // Static-mode helper should appear
    await expect(
      page.locator("text=copy these env vars to persist this connector").first()
    ).toBeVisible({ timeout: 5_000 });
    // Save button should be disabled
    const saveBtn = page.getByRole("button", { name: /^Save$/ }).first();
    await expect(saveBtn).toBeDisabled();
  });

  test("welcome flow renders storage step (kv/file checkmark or static choice)", async ({
    page,
  }) => {
    await page.goto("/welcome");
    await page.waitForLoadState("networkidle");
    // Welcome may redirect to /config if already initialized; that's fine.
    if (page.url().includes("/welcome")) {
      // Look for any storage-related copy in the page
      const hasStorageCopy =
        (await page.locator("text=Storage").count()) > 0 ||
        (await page.locator("text=Upstash").count()) > 0 ||
        (await page.locator("text=env-vars").count()) > 0;
      expect(hasStorageCopy).toBe(true);
    }
  });
});
