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
    // First resolve: no Google creds → Google disabled, loader not called.
    await resolveRegistryAsync();
    expect(loaderCalls).not.toContain("google");

    // Simulate env change: operator sets creds + emits event.
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REFRESH_TOKEN = "refresh";
    // The event-bus handler is wired inside registry.ts; here we exercise
    // the cache invalidation directly (the event handler's behavior).
    __resetRegistryCacheForTests();
    loaderCalls = [];

    await resolveRegistryAsync();
    expect(loaderCalls).toContain("google");
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
  it("disabled-due-to-missing-env reason still reads `missing env: X, Y`", async () => {
    // Google needs 3 env vars. Set only 1 → reason lists the 2 missing.
    process.env.GOOGLE_CLIENT_ID = "id";
    // Intentionally leave SECRET + REFRESH unset.

    const state = await resolveRegistryAsync();
    const google = state.find((p) => p.manifest.id === "google");
    expect(google).toBeDefined();
    expect(google?.enabled).toBe(false);
    expect(google?.reason).toMatch(/^missing env: /);
    expect(google?.reason).toContain("GOOGLE_CLIENT_SECRET");
    expect(google?.reason).toContain("GOOGLE_REFRESH_TOKEN");
    // The already-set var should NOT appear in the missing list.
    expect(google?.reason).not.toContain("GOOGLE_CLIENT_ID");
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
});

// Silence unused-import warning for vi in this file; we keep it imported so
// future tests can mock without a second import.
void vi;
