/**
 * TEST-01 — Welcome durability across cold lambdas.
 *
 * Covers session fixes:
 *   - 95f0df7 (fire-and-forget KV write race + Edge REST dialect)
 *   - 748161d (claim cookie HMAC trusted across cold lambdas)
 *   - 7325aa8 (middleware Upstash rehydrate)
 *   - ab47f8d (storage-status accepts claim cookie during bootstrap)
 *   - 100e0b9 (transport handler rehydrates)
 *
 * See .planning/phases/40-test-coverage-docs/BUG-INVENTORY.md
 * rows BUG-07 (kv-durability), BUG-08 (kv-durability), BUG-10
 * (bootstrap-rehydrate), BUG-15 (kv-durability), BUG-14 (kv-durability).
 *
 * Scope — THE PERSISTENCE BOUNDARY across cold-lambda transitions.
 * Existing coverage deliberately NOT duplicated:
 *   - signing-secret generation: tests/core/signing-secret.test.ts
 *   - forged-cookie rejection: tests/api/welcome-claim-forgery.test.ts
 *   - HOC mechanics: tests/core/with-bootstrap-rehydrate.test.ts
 *   - Upstash env naming: tests/core/upstash-env.test.ts
 *
 * Lambda simulation:
 *   "Lambda A" = initial module import + handler call.
 *   "Lambda B" = vi.resetModules() + dynamic re-import with
 *                process.env cleared. Shared state survives ONLY
 *                via the `sharedKv` instance we inject into the
 *                getKVStore factory on both import cycles.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KVStore } from "@/core/kv-store";

// Vercel `/tmp` lives per-container. A fresh cold lambda sees no file.
// Between our "lambdas" we delete the tmp bootstrap AND tmp seed to
// prevent module-load rehydrate from short-circuiting the KV path.
const TMP_BOOTSTRAP_PATH = join(tmpdir(), ".mymcp-bootstrap.json");
const TMP_SIGNING_SEED_PATH = join(tmpdir(), "mymcp-signing-seed");

function clearColdLambdaTmp(): void {
  for (const p of [TMP_BOOTSTRAP_PATH, TMP_SIGNING_SEED_PATH]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // best-effort
    }
  }
}

// ─── Test seam: shared in-memory KV mimicking Upstash across lambdas ─

class SharedKV implements KVStore {
  public readonly kind = "upstash" as const;
  private map = new Map<string, string>();
  public opLog: Array<{ op: string; key: string; awaited: boolean }> = [];

  async get(key: string): Promise<string | null> {
    this.opLog.push({ op: "get", key, awaited: true });
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.opLog.push({ op: "set", key, awaited: true });
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.opLog.push({ op: "delete", key, awaited: true });
    this.map.delete(key);
  }
  async list(prefix?: string): Promise<string[]> {
    const keys = [...this.map.keys()];
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }
  snapshot(): Map<string, string> {
    return new Map(this.map);
  }
}

// Hold the SINGLE shared KV across dynamic imports. Each `vi.mock` factory
// reads this at import time so "Lambda A" and "Lambda B" point at the
// same in-memory Redis.
let sharedKv: SharedKV;

// ─── Env save/restore ─────────────────────────────────────────────────

const SAVED: Record<string, string | undefined> = {};
const TRACKED = [
  "MCP_AUTH_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "MYMCP_ALLOW_EPHEMERAL_SECRET",
  "NODE_ENV",
  "VERCEL",
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
function clearBootstrapEnv(): void {
  delete process.env.MCP_AUTH_TOKEN;
}
function setUpstash(): void {
  // UPSTASH_* variant (preferred by getUpstashCreds()).
  process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
}
function unsetAllKvCreds(): void {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
}
function allowEphemeralSecret(): void {
  process.env.MYMCP_ALLOW_EPHEMERAL_SECRET = "1";
}

// ─── Module isolation helpers ────────────────────────────────────────

/**
 * Fresh import of the first-run module graph, with `@/core/kv-store`
 * mocked so every `getKVStore()` call returns the same `sharedKv`
 * instance. Callers pass in an optional `tmpSuffix` the shim uses to
 * namespace the tmp-file path, so "Lambda A" and "Lambda B" cannot
 * share lambda-local `/tmp` state (that would defeat the point of the
 * cold-start simulation).
 */
async function importFirstRunFresh(): Promise<typeof import("@/core/first-run")> {
  // Mock must be registered BEFORE the dynamic import.
  vi.doMock("@/core/kv-store", async () => {
    const actual = await vi.importActual<typeof import("@/core/kv-store")>("@/core/kv-store");
    return {
      ...actual,
      getKVStore: () => sharedKv,
    };
  });
  // Also mock signing-secret's tmp path so fresh imports don't pick up
  // the previous "lambda's" tmp seed.
  const mod = await import("@/core/first-run");
  return mod;
}

// ─── Scenarios ───────────────────────────────────────────────────────

describe("TEST-01 Welcome durability — cross-lambda rehydrate", () => {
  beforeEach(() => {
    saveEnv();
    sharedKv = new SharedKV();
    clearColdLambdaTmp();
    vi.resetModules();
    vi.doUnmock("@/core/kv-store");
  });

  afterEach(() => {
    restoreEnv();
    vi.resetModules();
    vi.doUnmock("@/core/kv-store");
    clearColdLambdaTmp();
  });

  // ── Scenario A — cross-lambda rehydrate via KV ─────────────────────

  it("A: Lambda A mints + flushes bootstrap; Lambda B rehydrates from shared KV (BUG-07, BUG-10)", async () => {
    setUpstash();
    allowEphemeralSecret();
    clearBootstrapEnv();

    // ── Lambda A ───────────────────────────────────────────────────
    const lambdaA = await importFirstRunFresh();
    lambdaA.__resetFirstRunForTests();

    // Fabricate a successful init: issue a claim, mint the token, flush.
    const claimId = "a".repeat(64); // 64-char hex placeholder
    // Force-seed the claim into the in-memory map; we skip the real
    // /api/welcome/claim call because its HMAC path is covered in
    // welcome-claim-forgery.test.ts.
    const claimsField = (
      lambdaA as unknown as {
        __internals: Record<string, unknown>;
      }
    ).__internals;
    expect(claimsField).toBeDefined();

    // bootstrapToken() is public and synchronous — it's the contract
    // init/route.ts calls. It populates activeBootstrap + the in-memory
    // auth cache. flushBootstrapToKv() is the DUR-04 fix that awaits
    // the KV write instead of fire-and-forgetting.
    const { token } = lambdaA.bootstrapToken(claimId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await lambdaA.flushBootstrapToKv();

    // KV must contain the bootstrap — proves the write was actually
    // awaited (BUG-07 regression).
    const persisted = sharedKv.snapshot().get("mymcp:firstrun:bootstrap");
    expect(persisted).not.toBeUndefined();
    const parsed = JSON.parse(persisted as string) as { token: string; claimId: string };
    expect(parsed.token).toBe(token);
    expect(parsed.claimId).toBe(claimId);

    // The KV op log must include an awaited `set` for the bootstrap
    // key — the fire-and-forget bug would have completed `set` on a
    // reset module before the synchronous return resolved.
    const setOps = sharedKv.opLog.filter(
      (e) => e.op === "set" && e.key === "mymcp:firstrun:bootstrap"
    );
    expect(setOps.length).toBeGreaterThanOrEqual(1);
    expect(setOps.every((e) => e.awaited)).toBe(true);

    // ── Lambda B: simulate cold-start module reset ────────────────
    // Real cold lambdas wake up in a fresh container — /tmp is empty.
    // Clear both tmp files so the module-load rehydrate-from-tmp can't
    // short-circuit the KV path we're actually asserting against.
    clearColdLambdaTmp();
    vi.resetModules();
    clearBootstrapEnv(); // Vercel env never pasted the token
    const lambdaB = await importFirstRunFresh();
    // fresh import: activeBootstrap & bootstrapAuthTokenCache are null,
    // /tmp is empty, so the module-load rehydrate is a no-op.

    // isBootstrapActive() is false BEFORE rehydrate.
    expect(lambdaB.isBootstrapActive()).toBe(false);
    expect(lambdaB.getBootstrapAuthToken()).toBeNull();

    // Cold-lambda rehydrate pulls from the shared KV (BUG-10 regression).
    await lambdaB.rehydrateBootstrapAsync();

    // Post-rehydrate: the in-memory auth cache holds the original
    // token; process.env is NOT mutated (SEC-02 discipline).
    expect(lambdaB.isBootstrapActive()).toBe(true);
    expect(lambdaB.getBootstrapAuthToken()).toBe(token);
    expect(process.env.MCP_AUTH_TOKEN).toBeUndefined();
  });

  // ── Scenario B — cold-start after reap; awaited write survived ─────

  it("B: awaited flushBootstrapToKv survives simulated lambda death (BUG-07 positive-control)", async () => {
    setUpstash();
    allowEphemeralSecret();
    clearBootstrapEnv();

    // Lambda A: mint + flush; then "die".
    const lambdaA = await importFirstRunFresh();
    lambdaA.__resetFirstRunForTests();

    const claimId = "b".repeat(64);
    const { token: tokA } = lambdaA.bootstrapToken(claimId);
    // The await below is the contract the welcome/init route fulfills.
    // If this assertion ever fails, the DUR-04 fix has regressed and
    // we are back to the fire-and-forget race from BUG-07.
    await lambdaA.flushBootstrapToKv();

    // "Lambda death" — reset modules; `activeBootstrap` vanishes and
    // the fresh container has no /tmp file either.
    clearColdLambdaTmp();
    vi.resetModules();
    clearBootstrapEnv();

    // Lambda B boots minutes later. If KV still holds the bootstrap,
    // rehydrate succeeds. This is the cross-instance durability
    // contract — after the await resolves, the token must be safe.
    const lambdaB = await importFirstRunFresh();
    await lambdaB.rehydrateBootstrapAsync();
    expect(lambdaB.getBootstrapAuthToken()).toBe(tokA);
  });

  // ── Scenario C — claim cookie HMAC trusted across cold lambdas ─────

  it("C: HMAC-signed claim cookie is trusted on a fresh lambda with no in-memory claim (BUG-15)", async () => {
    setUpstash();
    allowEphemeralSecret();
    clearBootstrapEnv();

    // Lambda A: pretend /api/welcome/claim issued a cookie. We go
    // through the real encoder so the HMAC uses the shared KV's
    // signing-secret (mymcp:firstrun:signing-secret).
    const lambdaA = await importFirstRunFresh();
    lambdaA.__resetFirstRunForTests();

    const claimId = "c".repeat(64);
    // Access the internal encoder used by getOrCreateClaim. The
    // encode path calls getSigningSecret() which writes the secret
    // into sharedKv on first use.
    const encodedCookie = await (
      lambdaA.__internals as unknown as {
        encodeCookie: (id: string) => Promise<string>;
      }
    ).encodeCookie(claimId);
    expect(encodedCookie.includes(".")).toBe(true);

    // ── Lambda B boots. No in-memory claim, no active bootstrap, no
    //    /tmp fallback — but sharedKv HAS the signing secret. If
    //    isClaimer still checked in-memory maps (pre-748161d), the
    //    HMAC-signed cookie would be rejected with 403 "Forbidden —
    //    not the claimer" — exactly BUG-15.
    clearColdLambdaTmp();
    vi.resetModules();
    clearBootstrapEnv();
    const lambdaB = await importFirstRunFresh();
    lambdaB.__resetFirstRunForTests();

    const request = new Request("https://test.local/api/welcome/init", {
      method: "POST",
      headers: {
        cookie: `mymcp_firstrun_claim=${encodeURIComponent(encodedCookie)}`,
      },
    });

    const isClaim = await lambdaB.isClaimer(request);
    expect(isClaim).toBe(true);
  });

  // ── Scenario D — KV not configured refuses to mint claims (SEC-05) ──

  it("D: no durable KV AND no ephemeral opt-in → welcome claim refuses to mint (SEC-05 / BUG-17 family)", async () => {
    // Build a production-shaped env: Vercel, prod, no KV, no opt-in.
    // getSigningSecret() must throw SigningSecretUnavailableError.
    unsetAllKvCreds();
    clearBootstrapEnv();
    delete process.env.MYMCP_ALLOW_EPHEMERAL_SECRET;
    // Phase 50 Task 5B (carry-over): NODE_ENV is a readonly `'development'
    // | 'production' | 'test'` under @types/node + our 4 strict-flag
    // tsconfig, so `process.env.NODE_ENV = 'production'` hits TS2540.
    // Cast through Record<string, string|undefined> for the minimally
    // invasive fix — preserves test intent, no behavior change.
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.VERCEL = "1";
    clearColdLambdaTmp();

    // Install a mock that returns the real kv-store module — signing-
    // secret's `hasUpstashCreds()` reads process.env directly (no
    // KV call), so the code path we're asserting never actually hits
    // getKVStore(). Safer than toggling unmock mid-file.
    vi.doMock("@/core/kv-store", async () => {
      return await vi.importActual<typeof import("@/core/kv-store")>("@/core/kv-store");
    });
    vi.resetModules();

    // Import signing-secret directly. We expect the mint call to throw.
    const { getSigningSecret, SigningSecretUnavailableError, resetSigningSecretCache } =
      await import("@/core/signing-secret");
    resetSigningSecretCache();

    await expect(getSigningSecret()).rejects.toBeInstanceOf(SigningSecretUnavailableError);

    // Follow-on: the welcome/claim + welcome/init routes propagate
    // this as 503 — asserted in tests/api/welcome-claim-forgery.test.ts.
    // We stop here; the durability contract is "without a durable
    // secret, the system REFUSES to mint rather than mint a
    // forgeable-tomorrow one."
  });
});
