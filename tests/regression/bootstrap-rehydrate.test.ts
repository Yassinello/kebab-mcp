/**
 * TEST-03 batch B.2 — bootstrap-rehydrate regressions.
 *
 * Maps to BUG-INVENTORY.md rows: BUG-10, BUG-11.
 * One it() per bug; assertion name mirrors the BUG-NN ID.
 *
 * Covered session fixes:
 *   - 7325aa8 — middleware rehydrates bootstrap from Upstash (BUG-10)
 *   - 100e0b9 — MCP transport handler rehydrates on entry (BUG-11)
 *
 * Strategy: grep + import contract. The post-Phase-37 shape wraps
 * both the middleware and the transport handler in the same
 * `withBootstrapRehydrate` / `ensureBootstrapRehydratedFromUpstash`
 * seam. TEST-04 covers the middleware behavior directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── Tests ───────────────────────────────────────────────────────────

describe("TEST-03 batch B.2 — bootstrap-rehydrate regressions", () => {
  // ── BUG-10 — proxy() calls Edge rehydrate (7325aa8) ─────────────────
  it("regression: BUG-10 middleware-driven proxy() calls ensureBootstrapRehydratedFromUpstash", () => {
    // The post-fix shape: proxy.ts imports ensureBootstrapRehydratedFromUpstash
    // from @/core/first-run-edge and awaits it at function entry.
    const proxyFile = readFileSync(resolve(process.cwd(), "proxy.ts"), "utf-8");

    // Import present.
    expect(proxyFile).toMatch(
      /import\s+{\s*ensureBootstrapRehydratedFromUpstash\s*}\s+from\s+["']@\/core\/first-run-edge["']/
    );

    // Awaited call present in the proxy() body.
    expect(proxyFile).toMatch(/await\s+ensureBootstrapRehydratedFromUpstash\s*\(\s*\)/);

    // The call must land BEFORE the first-time-setup decision — we
    // assert this by position in the file.
    const awaitIdx = proxyFile.search(/await\s+ensureBootstrapRehydratedFromUpstash/);
    const setupIdx = proxyFile.search(/isFirstTimeSetup|MCP_AUTH_TOKEN[\s\S]{0,50}!isShowcase/);
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(setupIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeLessThan(setupIdx);
  });

  // ── BUG-11 — transport route triggers rehydrate on entry (100e0b9) ─
  it("regression: BUG-11 transport route rehydrates on entry (HOC / inline / pipeline)", () => {
    // 100e0b9 originally added `await rehydrateBootstrapAsync()` at
    // the top of the handler. Phase 37 replaced the manual call
    // with the `withBootstrapRehydrate` HOC (DUR-01 sweep). Phase 41
    // replaced the HOC with `composeRequestPipeline([rehydrateStep, …])`
    // (PIPE-02/PIPE-07). All three shapes close the underlying bug —
    // we accept any of them.
    const transport = readFileSync(resolve(process.cwd(), "app/api/[transport]/route.ts"), "utf-8");

    const hasHoc = /withBootstrapRehydrate\s*\(/.test(transport);
    const hasInlineRehydrate = /await\s+rehydrateBootstrapAsync/.test(transport);
    const hasPipelineRehydrate =
      /composeRequestPipeline\s*\(/.test(transport) && /\brehydrateStep\b/.test(transport);
    expect(hasHoc || hasInlineRehydrate || hasPipelineRehydrate).toBe(true);

    // The rehydrate entry point must be present either way.
    expect(transport).toMatch(/withBootstrapRehydrate|rehydrateBootstrapAsync|rehydrateStep/);
  });
});
