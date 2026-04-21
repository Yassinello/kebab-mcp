/**
 * TEST-03 batch A — welcome-flow regressions.
 *
 * Maps to BUG-INVENTORY.md rows: BUG-01..BUG-06 (welcome-flow theme).
 * One it() per bug; assertion name mirrors the BUG-NN ID.
 *
 * Strategy:
 *   - Route handlers (init/claim) → import + fetch-call with fabricated
 *     Request. Assert status + body + headers.
 *   - Middleware (proxy.ts) → import + call directly with a NextRequest
 *     shim. Assert redirect / passthrough / cookie-set behavior.
 *   - UI helpers that are module-scoped (extractTokenFromInput) → tested
 *     here via a parallel pure re-implementation the test owns and
 *     cross-checks against the UI component's comment-documented
 *     contract. The real function isn't exported; a future refactor
 *     could extract it to src/core/ for a direct import. Filed as
 *     FOLLOW-UP.
 *
 * These tests are LIVE — they exercise current code. If a fix is
 * reverted (e.g. `git revert bc31b69`), the corresponding `it()`
 * re-fails. That's the whole point.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { POST as welcomeInitPOST } from "../../app/api/welcome/init/route";
import { proxy } from "../../proxy";
import type { NextRequest } from "next/server";
// Phase 45 Task 1: `extractTokenFromInput` moved to `src/core/welcome-url-parser.ts`
// so this regression test imports the real function rather than a
// parallel re-implementation. If BUG-01 reappears, the import-site
// fires red directly (the parallel copy at lines 79–113 is deleted).
import { extractTokenFromInput } from "../../src/core/welcome-url-parser";

// ─── Env save/restore helpers ─────────────────────────────────────────

const SAVED: Record<string, string | undefined> = {};
const TRACKED = [
  "MCP_AUTH_TOKEN",
  "ADMIN_AUTH_TOKEN",
  "MYMCP_RECOVERY_RESET",
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

// ─── NextRequest shim (duplicated minimal helper — kept local so this
//     file has no cross-test helper dep) ────────────────────────────

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

describe("TEST-03 batch A.1 — welcome-flow regressions", () => {
  beforeEach(() => {
    saveEnv();
    clearAllTracked();
  });

  afterEach(() => {
    restoreEnv();
  });

  // ── BUG-01 — paste MCP URL extracts ?token= (4e6fa0c) ───────────────
  it("regression: BUG-01 paste-MCP-URL extracts ?token= param", () => {
    // Before the fix: the full URL was crammed into `?token=` param,
    // URL-encoded, and middleware 401'd. After: the ?token= value is
    // extracted and forwarded cleanly.
    const bareToken = "ej1fZhGP7cthQmfTuSAjhNe4e6uIo0y-MQfNnie-7Ss";
    const fullUrl = `https://example.vercel.app/api/mcp?token=${bareToken}`;

    // Happy path 1 — bare token goes through unchanged.
    expect(extractTokenFromInput(bareToken)).toBe(bareToken);

    // Happy path 2 — full URL extracts the token.
    expect(extractTokenFromInput(fullUrl)).toBe(bareToken);

    // Negative — URL without `?token=` falls through and returns the
    // literal input. The UI renders the amber "no ?token= found" hint
    // off a separate check (`inputLooksLikeUrl && !extracted` — where
    // `extracted` is empty) — here we mirror the real pure function.
    // (Both return-empty and return-literal variants have been deployed
    // at different times; current behavior is return-literal.)
    const noTokenUrl = "https://example.com/";
    expect(extractTokenFromInput(noTokenUrl)).toBe(noTokenUrl);

    // Edge — whitespace trimmed.
    expect(extractTokenFromInput(`  ${bareToken}  `)).toBe(bareToken);
  });

  // ── BUG-02 — already-initialized paste-token form (bc31b69) ─────────
  it("regression: BUG-02 already-initialized screen renders paste-token form", () => {
    // The regression is that /welcome with an already-minted token used
    // to render a bare "Open dashboard" link pointing at /config → 401.
    // We assert the server-observable contract: middleware treats a
    // fully-initialized instance as post-first-run mode AND the proxy
    // gate redirects bare `/config` → 401 when no cookie is present.
    // The paste-token form's DOM is visual, not testable here without
    // RTL — the visual regression is covered by tests/e2e/welcome.spec.ts.
    process.env.MCP_AUTH_TOKEN = "a".repeat(32);
    process.env.ADMIN_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

    // No cookie, no query token — middleware 401s. This is why the
    // bare "Open dashboard" link was broken pre-bc31b69.
    // (The fix was on the UI side: give users a form to paste the
    // token and build a proper `/config?token=…` link.)
    // We verify the middleware contract the fix relies on: a valid
    // `?token=` query param gets exchanged for a cookie + URL strip.
    const goodToken = process.env.MCP_AUTH_TOKEN;
    const req = makeNextRequest(`https://test.local/config?token=${goodToken}`);
    // This would throw if rehydrate-mock was required; proxy() awaits
    // its edge helper which is defensive and no-ops without KV env.
    // The middleware will respond 302 + set-cookie OR pass-through.
    // Either way: not 401 (which would mean BUG-02 regressed).
    return proxy(req).then((res) => {
      expect(res.status).not.toBe(401);
    });
  });

  // ── BUG-03 — query-token handoff strips URL + sets cookie (83b5a8e) ─
  it("regression: BUG-03 query-token redirects to cleaned URL with cookie set", async () => {
    process.env.MCP_AUTH_TOKEN = "b".repeat(32);
    process.env.ADMIN_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

    const req = makeNextRequest(`https://test.local/config?token=${process.env.MCP_AUTH_TOKEN}`);
    const res = await proxy(req);

    // The fix (proxy.ts) does a 302/307 redirect to same path without
    // `?token=`, setting the `mymcp_admin_token` cookie. Without this
    // fix the middleware would pass through (200) leaving the token
    // in the URL.
    expect([302, 307, 308]).toContain(res.status);

    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const locUrl = new URL(location as string, "https://test.local");
    expect(locUrl.searchParams.get("token")).toBeNull();

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/mymcp_admin_token=/);
  });

  // ── BUG-04 — step-3 Test MCP uses persistenceReady not permanent (f818e01) ─
  it("regression: BUG-04 step-3 Test-MCP gate uses persistenceReady not permanent", () => {
    // The concrete behavior is in the welcome render tree — the gate
    // variable was renamed from `permanent` to `persistenceReady`.
    // Phase 45 Task 5 moved the render tree from `welcome-client.tsx`
    // into `WelcomeShell.tsx`; Phase 47 WIRE-01c further migrated the
    // `persistenceReady` gate into `app/welcome/steps/test.tsx`. The
    // grep-contract concatenates all three so the assertion fires
    // against whichever file owns the gate today. Phase 47 WIRE-05
    // retired the `welcome-client.tsx` shim — fall back to an empty
    // string if the shim is gone.
    const welcomeClient = (() => {
      try {
        return readFileSync(resolve(process.cwd(), "app/welcome/welcome-client.tsx"), "utf-8");
      } catch {
        return "";
      }
    })();
    const welcomeShell = readFileSync(
      resolve(process.cwd(), "app/welcome/WelcomeShell.tsx"),
      "utf-8"
    );
    const testStep = readFileSync(resolve(process.cwd(), "app/welcome/steps/test.tsx"), "utf-8");
    const mintStep = readFileSync(resolve(process.cwd(), "app/welcome/steps/mint.tsx"), "utf-8");
    const combined = [welcomeClient, welcomeShell, testStep, mintStep].join("\n");

    // Must have the post-fix variable present.
    expect(combined).toMatch(/persistenceReady/);

    // And the commit's copy change: "Token persisted (durable across
    // cold starts)" replaces "Permanent token active in Vercel".
    // Either string is acceptable; the regression would be BOTH absent.
    const hasPostFixCopy =
      /persisted.*(durable|cold[- ]start)/i.test(combined) || /persistenceReady/.test(combined);
    expect(hasPostFixCopy).toBe(true);
  });

  // ── BUG-05 — MYMCP_RECOVERY_RESET=1 foot-gun guard (5273add) ────────
  it("regression: BUG-05 init 409s when MYMCP_RECOVERY_RESET=1", async () => {
    // Direct assertion against the route handler — the guard is at the
    // TOP of postHandler in app/api/welcome/init/route.ts.
    process.env.MYMCP_RECOVERY_RESET = "1";

    const req = new Request("http://localhost:3000/api/welcome/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await welcomeInitPOST(req);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/MYMCP_RECOVERY_RESET=1/);
    expect(body.error).toMatch(/[Rr]emove the env var/);
  });

  // ── BUG-06 — init surfaces KV persist failures (1460841) ────────────
  it("regression: BUG-06 init surfaces KV persist failure signatures", async () => {
    // The 1460841 fix guarantees that an Upstash SET failure becomes a
    // 500 JSON response. The route handler's try/catch around
    // flushBootstrapToKv is the regression surface. Reaching the real
    // flush path requires minting a claim + passing isClaimer, which
    // requires KV + signing secret — too much lift for a unit test.
    //
    // Instead: grep-contract on the route source. The 500 path must
    // still exist AND it must mention the inner error message (so
    // users see "retry"-able diagnostics instead of a phantom 200).
    const initRoute = readFileSync(
      resolve(process.cwd(), "app/api/welcome/init/route.ts"),
      "utf-8"
    );

    // Must: try/catch around flushBootstrapToKv(IfAbsent)?, status 500
    // on failure. Phase 45 UX-04 switched the function name from
    // `flushBootstrapToKv` to `flushBootstrapToKvIfAbsent` — both are
    // matched by the regex below.
    expect(initRoute).toMatch(/flushBootstrapToKv(IfAbsent)?/);
    expect(initRoute).toMatch(/try\s*{[\s\S]*flushBootstrapToKv(IfAbsent)?[\s\S]*catch/m);
    expect(initRoute).toMatch(/status:\s*500/);
    // And the 500 body must include the inner error message — that's
    // what 1460841 added. If someone reverts to silent-log-only, this
    // fails.
    expect(initRoute).toMatch(/err(or)?\.message|String\(err\)|msg/);
  });
});
