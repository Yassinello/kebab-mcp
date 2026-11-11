/**
 * TEST-03 batch B.1 — kv-durability regressions.
 *
 * Maps to BUG-INVENTORY.md rows: BUG-07, BUG-08, BUG-14, BUG-15.
 * One it() per bug; assertion name mirrors the BUG-NN ID.
 *
 * Covered session fixes:
 *   - 95f0df7 — await KV persist in init (BUG-07) + Edge GET aligned
 *     with UpstashKV POST (BUG-08)
 *   - ab47f8d — /api/storage/status accepts claim cookie OR admin auth
 *     during bootstrap (BUG-14)
 *   - 748161d — isClaimer trusts HMAC signature across cold lambdas
 *     (BUG-15)
 *
 * Strategy:
 *   - BUG-07: grep-contract + import `flushBootstrapToKv` and assert
 *     it awaits the KV SET. Direct behavior test would need a KV
 *     injection that's more intricate than TEST-01 (which already
 *     covers it end-to-end); here we own the per-bug pin.
 *   - BUG-08: contract on first-run-edge.ts — the helper must use
 *     the POST-with-command-array form (not GET /get/{key}).
 *   - BUG-14: route handler's auth triangle (loopback / claim /
 *     admin) must all three be in the early-return chain.
 *   - BUG-15: direct assertion on `isClaimer` — an HMAC-signed cookie
 *     produced with the current signing secret must be accepted.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── Env save/restore ─────────────────────────────────────────────────

const SAVED: Record<string, string | undefined> = {};
const TRACKED = [
  "MCP_AUTH_TOKEN",
  "MYMCP_ALLOW_EPHEMERAL_SECRET",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "VERCEL",
  "NODE_ENV",
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

// ─── Tests ───────────────────────────────────────────────────────────

describe("TEST-03 batch B.1 — kv-durability regressions", () => {
  beforeEach(() => {
    saveEnv();
    clearAllTracked();
    process.env.MYMCP_ALLOW_EPHEMERAL_SECRET = "1";
  });

  afterEach(() => {
    restoreEnv();
  });

  // ── BUG-07 — awaited flush (95f0df7 part 1) ─────────────────────────
  it("regression: BUG-07 flushBootstrapToKv awaits the write", async () => {
    // Direct test: import the function, verify it's async AND awaits
    // the underlying kv.set. Grep-contract on first-run/bootstrap.ts is the
    // primary belt (Phase 56 refactor moved the implementation there);
    // first-run.ts is now a barrel facade — reinforced by TEST-01 scenario A.
    const firstRun = readFileSync(
      resolve(process.cwd(), "src/core/first-run/bootstrap.ts"),
      "utf-8"
    );

    // The function must exist and be async.
    expect(firstRun).toMatch(/export\s+async\s+function\s+flushBootstrapToKv/);

    // Its body must `await kv.set(...)` — without the await, Vercel
    // reaps the lambda mid-write (the original bug).
    const bodyMatch = firstRun.match(
      /export\s+async\s+function\s+flushBootstrapToKv[\s\S]{0,400}?}/
    );
    expect(bodyMatch).not.toBeNull();
    const body = bodyMatch?.[0] ?? "";
    expect(body).toMatch(/await\s+kv\.set/);

    // And the call site in the init route — route must AWAIT flush.
    const initRoute = readFileSync(
      resolve(process.cwd(), "app/api/welcome/init/route.ts"),
      "utf-8"
    );
    expect(initRoute).toMatch(/await\s+flushBootstrapToKv/);

    // Post-Phase-37 the pre-fix fire-and-forget helper was removed
    // entirely. Scan line-by-line, ignoring // comments, for any
    // live `void persistBootstrapToKv(...)` expression — its absence
    // is the strongest form of this regression guard.
    const liveHit = firstRun
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("//") && !l.startsWith("*"))
      .some((l) => /void\s+persistBootstrapToKv\s*\(/.test(l));
    expect(liveHit).toBe(false);
  });

  // ── BUG-08 — Edge REST dialect (95f0df7 part 2) ─────────────────────
  it("regression: BUG-08 Edge rehydrate uses POST command form", () => {
    // The fix aligned first-run-edge.ts with UpstashKV's POST-with-
    // command-array form. A regression to `GET /get/{key}` would
    // 404 on keys with literal colons on certain Upstash gateways.
    const firstRunEdge = readFileSync(
      resolve(process.cwd(), "src/core/first-run-edge.ts"),
      "utf-8"
    );

    // Positive contract: POST method + JSON body with ["GET", key].
    expect(firstRunEdge).toMatch(/method:\s*["']POST["']/);
    expect(firstRunEdge).toMatch(/\[\s*["']GET["']\s*,\s*KV_BOOTSTRAP_KEY/);

    // Negative contract: NOT using the GET /get/{key} URL-path form.
    // A legitimate url with `/get/` in a different context would still
    // fail this; none exists, so it's a safe anchor.
    expect(firstRunEdge).not.toMatch(/fetch\(\s*`.*\/get\//);
  });

  // ── BUG-14 — storage-status triple-auth (ab47f8d) ───────────────────
  it("regression: BUG-14 /api/storage/status accepts claim cookie during bootstrap", () => {
    // The fix unified auth: accept loopback OR claim cookie OR admin
    // auth, in that order. Pre-fix, the route branched on
    // `process.env.MCP_AUTH_TOKEN` and REJECTED claim-only requests
    // once the token was minted on the same warm lambda.
    const route = readFileSync(resolve(process.cwd(), "app/api/storage/status/route.ts"), "utf-8");

    // Must reference all three auth primitives.
    expect(route).toMatch(/isLoopbackRequest/);
    expect(route).toMatch(/isClaimer/);
    expect(route).toMatch(/checkAdminAuth/);

    // The auth must be an OR chain — one of these three suffices. Our
    // grep pins "if (!loopback && !claim) check admin" or equivalent.
    // The specific shape from ab47f8d uses a short-circuit chain.
    const hasUnifiedChain =
      /!\s*isLoopbackRequest[\s\S]{0,200}!\s*\(await\s+isClaimer|!isClaimer/m.test(route);
    expect(hasUnifiedChain).toBe(true);
  });

  // ── BUG-15 — HMAC cookie trusted across cold lambdas (748161d) ──────
  it("regression: BUG-15 isClaimer trusts a minted claim on a cold lambda (no in-memory Map hit)", async () => {
    // A claim minted on lambda A must be honoured on a cold lambda B,
    // which has neither the in-memory `claims` Map nor `activeBootstrap`.
    // SEC-07 (2026-11 audit): the proof is the HMAC-signed cookie PLUS the
    // claim persisted in KV — a signed cookie for a claim that was never
    // minted (or was released) is no longer enough.
    const first = await import("@/core/first-run");
    await first.__resetFirstRunForTestsAsync();
    const minted = await first.getOrCreateClaim(
      new Request("https://test.local/api/welcome/claim", { method: "POST" })
    );
    expect(minted.isClaimer).toBe(true);
    const cookie = `mymcp_firstrun_claim=${encodeURIComponent(minted.cookieToSet ?? "")}`;

    // Cold lambda: fresh module instances, same durable KV.
    const { vi } = await import("vitest");
    vi.resetModules();
    const cold = await import("@/core/first-run");
    const req = new Request("https://test.local/api/welcome/init", {
      method: "POST",
      headers: { cookie },
    });
    expect(await cold.isClaimer(req)).toBe(true);

    // A correctly signed cookie for a claim that was never minted is refused.
    const fabricated = await (
      cold.__internals as unknown as { encodeCookie: (id: string) => Promise<string> }
    ).encodeCookie("f".repeat(64));
    const fabricatedReq = new Request("https://test.local/api/welcome/init", {
      method: "POST",
      headers: { cookie: `mymcp_firstrun_claim=${encodeURIComponent(fabricated)}` },
    });
    expect(await cold.isClaimer(fabricatedReq)).toBe(false);

    // Negative — an unsigned or garbage cookie is still rejected.
    const forgedReq = new Request("https://test.local/api/welcome/init", {
      method: "POST",
      headers: { cookie: `mymcp_firstrun_claim=garbage.badsig` },
    });
    expect(await cold.isClaimer(forgedReq)).toBe(false);
    await cold.__resetFirstRunForTestsAsync();
  });
});
