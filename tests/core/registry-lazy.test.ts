/**
 * tests/core/registry-lazy.test.ts
 *
 * Covers the PERF-01 lazy-loader behavior of `src/core/registry.ts`:
 *
 * 1. Disabled connectors (missing env) never invoke their loader.
 * 2. Concurrent `resolveRegistryAsync` calls dedupe via an in-flight Map —
 *    each active connector's loader runs exactly once across parallel
 *    resolves.
 * 3. `MYMCP_DISABLE_<PACK>=true` skips the loader even when credentials
 *    are present. Reason string stays stable for downstream UI parsing.
 * 4. `env.changed` event bus notification invalidates the cache so the
 *    next resolve re-gates against the (possibly mutated) process.env.
 * 5. `registerPrompts` runtime validation still throws if a manifest
 *    assigns a non-function — contract preserved.
 * 6. `resolveRegistry()` (sync) works after a warm `resolveRegistryAsync`,
 *    and throws a clear error if called before any async resolve.
 * 7. Missing-env reason string still reads `missing env: X, Y` — downstream
 *    Connectors tab parses this exact prefix.
 *
 * Tests mutate process.env directly; `fileParallelism: false` in the
 * vitest config means test files do not interleave, so env mutations
 * are safe. Each test resets env via afterEach + clears the registry
 * cache via `__resetRegistryCacheForTests()`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConnectorManifest } from "@/core/types";
import {
  ALL_CONNECTOR_LOADERS,
  resolveRegistryAsync,
  resolveRegistry,
  __resetRegistryCacheForTests,
  __setLoaderSpyForTests,
  __clearLoaderSpyForTests,
} from "@/core/registry";

type EnvSnapshot = Record<string, string | undefined>;

const CREDENTIAL_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GITHUB_TOKEN",
  "NOTION_API_KEY",
  "SLACK_BOT_TOKEN",
  "APIFY_TOKEN",
  "LINEAR_API_KEY",
  "AIRTABLE_API_KEY",
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "OPENROUTER_API_KEY",
  "COMPOSIO_API_KEY",
  "SOURCE_MEDIUM_COOKIE",
  "SOURCE_SUBSTACK_COOKIE",
  "MYMCP_WEBHOOKS",
  "GITHUB_PAT",
  "GITHUB_REPO",
  // Phase 76: the slack/notion gate reads the multi-account index from the
  // gate env. In prod these arrive via the hydrated KV snapshot under the
  // `cred:`-stripped key; in this test we inject them straight into
  // process.env (buildGateEnv spreads process.env) to exercise isActive().
  "acct:slack:__index__",
  "acct:notion:__index__",
];

const TOGGLE_VARS = [
  "MYMCP_DISABLE_GOOGLE",
  "MYMCP_DISABLE_VAULT",
  "MYMCP_DISABLE_BROWSER",
  "MYMCP_DISABLE_SLACK",
  "MYMCP_DISABLE_NOTION",
  "MYMCP_DISABLE_COMPOSIO",
  "MYMCP_DISABLE_APIFY",
  "MYMCP_DISABLE_GITHUB",
  "MYMCP_DISABLE_LINEAR",
  "MYMCP_DISABLE_AIRTABLE",
  "MYMCP_DISABLE_PAYWALL",
  "MYMCP_DISABLE_WEBHOOK",
  "KEBAB_ENABLED_PACKS",
];

function snapshotEnv(): EnvSnapshot {
  const s: EnvSnapshot = {};
  for (const k of [...CREDENTIAL_VARS, ...TOGGLE_VARS]) s[k] = process.env[k];
  return s;
}

function restoreEnv(s: EnvSnapshot) {
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearAll() {
  for (const k of [...CREDENTIAL_VARS, ...TOGGLE_VARS]) delete process.env[k];
}

describe("registry lazy loaders (PERF-01)", () => {
  let savedEnv: EnvSnapshot;
  let loaderCalls: string[];

  beforeEach(() => {
    savedEnv = snapshotEnv();
    clearAll();
    __resetRegistryCacheForTests();
    loaderCalls = [];
    __setLoaderSpyForTests((id) => {
      loaderCalls.push(id);
    });
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    __resetRegistryCacheForTests();
    __clearLoaderSpyForTests();
  });

  // Test 1
  it("disabled connector's loader is never awaited (PERF-01 core win)", async () => {
    // No BROWSERBASE_* / COMPOSIO_API_KEY / APIFY_TOKEN — those should not load.
    await resolveRegistryAsync();
    expect(loaderCalls).not.toContain("browser");
    expect(loaderCalls).not.toContain("composio");
    expect(loaderCalls).not.toContain("apify");
    // Core always-on connectors (skills, admin) DO load.
    expect(loaderCalls).toContain("skills");
    expect(loaderCalls).toContain("admin");
  });

  // Test 2
  it("concurrent resolveRegistryAsync dedupes in-flight loads", async () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REFRESH_TOKEN = "refresh";
    __resetRegistryCacheForTests();
    loaderCalls = [];

    // Three concurrent resolves. The in-flight Map must dedupe; Google's
    // loader should be called exactly once across all three.
    await Promise.all([resolveRegistryAsync(), resolveRegistryAsync(), resolveRegistryAsync()]);
    const googleLoads = loaderCalls.filter((id) => id === "google").length;
    expect(googleLoads).toBe(1);
    // Same for any other active loader — invoked at most once.
    const counts = new Map<string, number>();
    for (const id of loaderCalls) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, n] of counts) {
      expect(n, `loader ${id} invoked ${n} times`).toBe(1);
    }
  });

  // Test 3
  it("MYMCP_DISABLE_<PACK>=true skips the loader even when creds are set", async () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REFRESH_TOKEN = "refresh";
    process.env.MYMCP_DISABLE_GOOGLE = "true";

    const state = await resolveRegistryAsync();
    expect(loaderCalls).not.toContain("google");
    const google = state.find((p) => p.manifest.id === "google");
    expect(google).toBeDefined();
    expect(google?.enabled).toBe(false);
    expect(google?.reason).toBe("disabled via MYMCP_DISABLE_GOOGLE");
  });

  // Test 4
  it("env.changed event invalidates cache so next resolve re-gates", async () => {
    // First resolve: no creds. composio gates purely on COMPOSIO_API_KEY
    // (no hasCustomActive), so its loader is skipped while disabled.
    // (Google now has hasCustomActive — its loader runs to evaluate
    // isActive() even when disabled, like slack/notion — so it is no longer
    // a valid "lazy-skip" example here.)
    await resolveRegistryAsync();
    expect(loaderCalls).not.toContain("composio");

    // Simulate env change: operator sets the credential + emits event.
    process.env.COMPOSIO_API_KEY = "comp_test";
    // The event-bus handler is wired inside registry.ts; here we exercise
    // the cache invalidation directly (the event handler's behavior).
    __resetRegistryCacheForTests();
    loaderCalls = [];

    await resolveRegistryAsync();
    expect(loaderCalls).toContain("composio");
  });

  // Test 5
  it("registerPrompts runtime validation fires for bad manifest", async () => {
    // Simulate a loader that returns a bogus manifest. We use a fake id
    // and register it via the spy hook — but the production code validates
    // at load time inside `resolveRegistryAsync`. We cannot easily inject
    // a fake loader without refactoring, so we test against a real loader
    // that we mock to return a bad manifest via vi.mock.
    //
    // Simplest path: import the registry's internal `validateRegisterPrompts`
    // helper if exported; call it directly with a bad manifest.
    const mod = await import("@/core/registry");
    const validate = (
      mod as unknown as { __validateRegisterPromptsForTests?: (m: ConnectorManifest) => void }
    ).__validateRegisterPromptsForTests;
    expect(validate).toBeTypeOf("function");
    const badManifest: ConnectorManifest = {
      id: "bad-test",
      label: "Bad",
      description: "test",
      requiredEnvVars: [],
      tools: [],
      // Type-cast to bypass TS for the test; production accepts unknown via manifest loader.
      registerPrompts: 42 as unknown as (s: unknown) => void,
    };
    expect(() => validate!(badManifest)).toThrow(/must be a function/);
  });

  // Test 6
  it("sync resolveRegistry() works warm; throws clear error when cold", async () => {
    __resetRegistryCacheForTests();
    // Cold: no async resolve has been called yet.
    expect(() => resolveRegistry()).toThrow(
      /resolveRegistryAsync\(\) first|lazy loaders need async context/i
    );

    // Warm it up.
    await resolveRegistryAsync();

    // Sync call now returns the cached shape.
    const syncState = resolveRegistry();
    expect(Array.isArray(syncState)).toBe(true);
    expect(syncState.length).toBe(ALL_CONNECTOR_LOADERS.length);
  });

  // Test 7
  it("disabled-due-to-missing-env reason still reads `missing env: X`", async () => {
    // v0.19: Google now gates via manifest.isActive() (hasCustomActive),
    // which requires the primary GOOGLE_REFRESH_TOKEN (the per-account secret)
    // and returns a fixed `missing env: GOOGLE_REFRESH_TOKEN` reason — the
    // client id/secret are stored per-account but are not the gate key.
    // Set client id only → still disabled (no refresh token).
    process.env.GOOGLE_CLIENT_ID = "id";

    const state = await resolveRegistryAsync();
    const google = state.find((p) => p.manifest.id === "google");
    expect(google).toBeDefined();
    expect(google?.enabled).toBe(false);
    expect(google?.reason).toMatch(/^missing env: /);
    expect(google?.reason).toContain("GOOGLE_REFRESH_TOKEN");
  });

  // Safety check: loader spy produces a stable id set matching the loader entries.
  it("loader spy captures all active loader invocations, no duplicates", async () => {
    process.env.NOTION_API_KEY = "secret_test";
    __resetRegistryCacheForTests();
    loaderCalls = [];

    await resolveRegistryAsync();
    const uniques = new Set(loaderCalls);
    expect(uniques.size).toBe(loaderCalls.length);
    // Notion is active; its loader ran.
    expect(uniques.has("notion")).toBe(true);
  });

  // ── Phase 76: multi-account gate for slack/notion ──────────────────
  // slack/notion now gate via manifest.isActive(env) (hasCustomActive),
  // accepting EITHER a legacy primary token OR a multi-account index ≥1.
  describe("multi-account gate (Phase 76)", () => {
    it("multi-account index ≥1 (no legacy token) → slack enabled", async () => {
      process.env["acct:slack:__index__"] = JSON.stringify({
        accounts: [{ slug: "acme", name: "Acme" }],
      });
      const state = await resolveRegistryAsync();
      const slack = state.find((p) => p.manifest.id === "slack");
      expect(slack?.enabled).toBe(true);
      expect(slack?.reason).toBe("active");
    });

    it("legacy SLACK_BOT_TOKEN only (no index) → slack enabled (back-compat)", async () => {
      process.env.SLACK_BOT_TOKEN = "xoxb-legacy";
      const state = await resolveRegistryAsync();
      const slack = state.find((p) => p.manifest.id === "slack");
      expect(slack?.enabled).toBe(true);
    });

    it("empty accounts array + no legacy token → slack disabled, `missing env:` reason", async () => {
      process.env["acct:slack:__index__"] = JSON.stringify({ accounts: [] });
      const state = await resolveRegistryAsync();
      const slack = state.find((p) => p.manifest.id === "slack");
      expect(slack?.enabled).toBe(false);
      // UI isConfigured heuristic depends on this exact prefix.
      expect(slack?.reason).toMatch(/^missing env: /);
      expect(slack?.reason).toContain("SLACK_BOT_TOKEN");
    });

    it("corrupt index + no legacy token → notion disabled", async () => {
      process.env["acct:notion:__index__"] = "{not json";
      const state = await resolveRegistryAsync();
      const notion = state.find((p) => p.manifest.id === "notion");
      expect(notion?.enabled).toBe(false);
      expect(notion?.reason).toContain("NOTION_API_KEY");
    });

    it("MYMCP_DISABLE_SLACK wins over a configured account", async () => {
      process.env["acct:slack:__index__"] = JSON.stringify({
        accounts: [{ slug: "acme", name: "Acme" }],
      });
      process.env.MYMCP_DISABLE_SLACK = "true";
      const state = await resolveRegistryAsync();
      const slack = state.find((p) => p.manifest.id === "slack");
      expect(slack?.enabled).toBe(false);
      expect(slack?.reason).toBe("disabled via MYMCP_DISABLE_SLACK");
    });
  });
});

// Silence unused-import warning for vi in this file; we keep it imported so
// future tests can mock without a second import.
void vi;
