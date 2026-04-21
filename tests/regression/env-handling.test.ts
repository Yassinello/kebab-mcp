/**
 * TEST-03 batch B.3 — env-handling regressions.
 *
 * Maps to BUG-INVENTORY.md rows: BUG-09, BUG-17.
 * One it() per bug; assertion name mirrors the BUG-NN ID.
 *
 * Covered session fixes:
 *   - 7f6ec80 — middleware reads KV_REST_API_URL alias for Vercel
 *     Marketplace Upstash (BUG-09)
 *   - d747a1f — showcase mode bypasses first-run redirect (BUG-17)
 *
 * Light cross-reference: BUG-05 (MYMCP_RECOVERY_RESET foot-gun guard)
 * has its canonical test in welcome-flow.test.ts. Here we add one
 * negative cross-check at the middleware-level as a sanity anchor,
 * but the BUG-05 row remains owned by welcome-flow.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { proxy } from "../../proxy";
import type { NextRequest } from "next/server";

// ─── Env save/restore ─────────────────────────────────────────────────

const SAVED: Record<string, string | undefined> = {};
const TRACKED = [
  "MCP_AUTH_TOKEN",
  "ADMIN_AUTH_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "INSTANCE_MODE",
];

function saveEnv(): void {
  for (const k of TRACKED) SAVED[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of TRACKED) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
}
function clearAllTracked(): void {
  for (const k of TRACKED) delete process.env[k];
}

// ─── NextRequest shim ────────────────────────────────────────────────

function makeNextRequest(url: string, opts?: { cookie?: string }): NextRequest {
  const req = new Request(url, {
    method: "GET",
    headers: opts?.cookie ? { cookie: opts.cookie } : {},
  });
  const nextUrl = new URL(url);
  const cookieMap = new Map<string, { value: string }>();
  if (opts?.cookie) {
    for (const pair of opts.cookie.split(";")) {
      const [k, v] = pair.trim().split("=");
      if (k && v) cookieMap.set(k, { value: v });
    }
  }
  return Object.assign(req, {
    nextUrl,
    cookies: { get: (k: string) => cookieMap.get(k) },
  }) as unknown as NextRequest;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("TEST-03 batch B.3 — env-handling regressions", () => {
  beforeEach(() => {
    saveEnv();
    clearAllTracked();
  });

  afterEach(() => {
    restoreEnv();
  });

  // ── BUG-09 — KV_REST_API_URL alias recognized (7f6ec80) ─────────────
  it("regression: BUG-09 middleware path accepts KV_REST_API_* variant", async () => {
    // The live regression belt — both env variants resolve via
    // getUpstashCreds() (DUR-06 unification). A revert to UPSTASH_*-only
    // reading would fail this test.
    const { getUpstashCreds } = await import("@/core/upstash-env");

    // UPSTASH_* variant resolves (pre-existing behavior).
    process.env.UPSTASH_REDIS_REST_URL = "https://u.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "u-tok";
    expect(getUpstashCreds()?.source).toBe("upstash-redis");

    // Remove UPSTASH, set KV_* — must still resolve (post-7f6ec80 fix).
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL = "https://k.kv.io";
    process.env.KV_REST_API_TOKEN = "k-tok";
    const creds = getUpstashCreds();
    expect(creds).not.toBeNull();
    expect(creds?.source).toBe("vercel-marketplace");

    // And first-run-edge.ts (where 7f6ec80 landed) routes through
    // this helper — grep-contract confirms it doesn't read env vars
    // directly anymore.
    const firstRunEdge = readFileSync(
      resolve(process.cwd(), "src/core/first-run-edge.ts"),
      "utf-8"
    );
    expect(firstRunEdge).toMatch(/getUpstashCreds/);
    // No direct env read of either variant in first-run-edge.ts.
    const directEnvRead = /process\.env\.(UPSTASH_REDIS_REST_|KV_REST_API_)/g.exec(firstRunEdge);
    expect(directEnvRead).toBeNull();
  });

  // ── BUG-17 — showcase mode bypasses first-run (d747a1f) ─────────────
  it("regression: BUG-17 showcase mode skips first-run redirect", async () => {
    // Showcase mode = INSTANCE_MODE=showcase + no MCP_AUTH_TOKEN.
    // Pre-d747a1f: middleware treated this as first-run and redirected
    // / → /welcome, locking the public demo behind the wizard.
    // Post-fix: /welcome and /config redirect back to /, which renders
    // the LandingPage.
    process.env.INSTANCE_MODE = "showcase";
    // No MCP_AUTH_TOKEN — the trigger condition.

    // Visiting /welcome on a showcase deploy must redirect to /.
    const welcomeReq = makeNextRequest("https://showcase.vercel.app/welcome");
    const welcomeRes = await proxy(welcomeReq);
    expect([302, 307, 308]).toContain(welcomeRes.status);
    const welcomeLoc = welcomeRes.headers.get("location");
    expect(welcomeLoc).toBeTruthy();
    expect(new URL(welcomeLoc as string, "https://showcase.vercel.app").pathname).toBe("/");

    // Visiting /config on a showcase deploy also redirects to /.
    const cfgReq = makeNextRequest("https://showcase.vercel.app/config");
    const cfgRes = await proxy(cfgReq);
    expect([302, 307, 308]).toContain(cfgRes.status);
    const cfgLoc = cfgRes.headers.get("location");
    expect(cfgLoc).toBeTruthy();
    expect(new URL(cfgLoc as string, "https://showcase.vercel.app").pathname).toBe("/");

    // Visiting / must NOT redirect to /welcome (the original bug) —
    // pass-through is the correct behavior so app/page.tsx can render.
    const rootReq = makeNextRequest("https://showcase.vercel.app/");
    const rootRes = await proxy(rootReq);
    // Accept pass-through (200 via NextResponse.next) or any non-302-
    // to-/welcome response.
    const rootLoc = rootRes.headers.get("location");
    if (rootLoc) {
      expect(rootLoc).not.toMatch(/\/welcome/);
    }
  });

  // ── Cross-check for BUG-05 (welcome-flow owner) ────────────────────
  it("cross-check: BUG-05 MYMCP_RECOVERY_RESET=1 does not crash middleware", async () => {
    // Not the canonical assertion — that's in welcome-flow.test.ts
    // (tests the 409 at /api/welcome/init). Here we just verify the
    // middleware stays healthy when the env var is set; a regression
    // that made proxy() crash on the env var would get caught here.
    process.env.MYMCP_RECOVERY_RESET = "1";
    process.env.MCP_AUTH_TOKEN = "recovery-reset-token-placeholder-hex";
    process.env.ADMIN_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

    const req = makeNextRequest("https://test.local/config", {
      cookie: `mymcp_admin_token=${process.env.MCP_AUTH_TOKEN}`,
    });
    const res = await proxy(req);
    // Any non-5xx response is fine — we're asserting "does not throw".
    expect(res.status).toBeLessThan(500);

    delete process.env.MYMCP_RECOVERY_RESET;
  });
});
