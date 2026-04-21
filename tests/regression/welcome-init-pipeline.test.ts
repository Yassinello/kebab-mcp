/**
 * welcome/init pipeline regression — Phase 41 Task 4.
 *
 * Asserts the `app/api/welcome/init/route.ts` file uses the pipeline
 * (contract anticipation for PIPE-06) and preserves the route-specific
 * gates that didn't fold into generic steps.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("welcome/init pipeline regression (Phase 41 Task 4)", () => {
  const routePath = resolve(process.cwd(), "app/api/welcome/init/route.ts");
  const source = readFileSync(routePath, "utf-8");

  it("route exports POST via composeRequestPipeline", () => {
    expect(source).toMatch(/composeRequestPipeline\(/);
    expect(source).toMatch(/export\s+const\s+POST\s*=\s*composeRequestPipeline/);
  });

  it("pipeline is exactly [rehydrateStep, csrfStep] — no authStep (bespoke isClaimer gate)", () => {
    expect(source).toMatch(/rehydrateStep/);
    expect(source).toMatch(/csrfStep/);
    // authStep NOT used — welcome/init's auth is the bespoke isClaimer gate
    expect(source).not.toMatch(/authStep\(/);
  });

  it("MYMCP_RECOVERY_RESET + firstRunMode gates stay inline in handler", () => {
    expect(source).toMatch(/MYMCP_RECOVERY_RESET/);
    expect(source).toMatch(/isFirstRunMode\(/);
    expect(source).toMatch(/isBootstrapActive\(/);
  });

  it("isClaimer gate preserved (SigningSecretUnavailableError branch intact)", () => {
    expect(source).toMatch(/await\s+isClaimer\(/);
    expect(source).toMatch(/SigningSecretUnavailableError/);
  });

  it("flushBootstrapToKv*(IfAbsent)? await + 500-on-failure branch preserved (DUR-04 + Phase 45 UX-04)", () => {
    // Phase 45 UX-04: route switched from `await flushBootstrapToKv()`
    // (non-atomic — last write wins when two browsers share a claim
    // cookie) to `await flushBootstrapToKvIfAbsent()` (SETNX-gated,
    // returns `{ ok: false, ... }` for the losing minter). Both
    // shapes preserve DUR-04's "await before responding" contract —
    // this regression accepts either.
    expect(source).toMatch(/await\s+flushBootstrapToKv(IfAbsent)?\(/);
    expect(source).toMatch(/persistence\s+to\s+KV\s+failed/);
  });

  it("UX-04: losing SETNX path returns 409 already_minted", () => {
    // Phase 45 UX-04 mint-race fix: when two concurrent POST
    // /api/welcome/init calls share the same claim cookie, exactly
    // one wins the SETNX and returns 200+token; the loser returns
    // 409 `{ error: "already_minted" }`. The handler does NOT echo
    // the winner's token in the 409 body.
    expect(source).toMatch(/already_minted/);
    expect(source).toMatch(/status:\s*409/);
    // Negative: the loser branch must NOT include the token in the
    // response body. We assert the shape by confirming the 409
    // branch doesn't contain a `token:` field near it.
    const loser = source.match(/flushResult\.ok[\s\S]{0,400}/)?.[0] ?? "";
    expect(loser).toMatch(/already_minted/);
    expect(loser).not.toMatch(/token:/);
  });

  it("legacy withBootstrapRehydrate HOC is gone (pipeline now owns rehydrate)", () => {
    expect(source).not.toMatch(/withBootstrapRehydrate/);
  });
});
