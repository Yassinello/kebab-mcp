/**
 * Registry env-var transition snapshot test.
 *
 * Ensures that setting / unsetting connector credential env vars flips
 * the registry enabled/disabled state as expected. Previously the
 * registry was only verified by `scripts/registry-test.ts` at the
 * connector-count level; nothing exercised the activation logic through
 * process.env mutations end-to-end.
 *
 * What a failure here tells you:
 * - A connector's requiredEnvVars drifted (added a new one that nothing
 *   in the test sets)
 * - The registry's activation predicate changed semantics
 * - A connector stopped respecting MYMCP_DISABLE_* toggles
 *
 * PERF-01: migrated from sync `resolveRegistry()` to async
 * `resolveRegistryAsync()` — the registry now lazy-loads connector
 * manifests. Every test awaits `enabledIds()` so the resolve happens
 * under an async frame.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveRegistryAsync, __resetRegistryCacheForTests } from "./registry";

type EnvSnapshot = Record<string, string | undefined>;

const CREDENTIAL_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_DEFAULT_REPO",
  "NOTION_API_KEY",
  "SLACK_BOT_TOKEN",
  "APIFY_TOKEN",
  "LINEAR_API_KEY",
  "AIRTABLE_API_KEY",
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "OPENROUTER_API_KEY",
  "COMPOSIO_API_KEY",
  // Paywall sources use SOURCE_xxx_COOKIE convention
  "SOURCE_MEDIUM_COOKIE",
  "SOURCE_SUBSTACK_COOKIE",
];

const TOGGLE_VARS = [
  "MYMCP_DISABLE_GOOGLE",
  "MYMCP_DISABLE_GITHUB",
  "MYMCP_DISABLE_NOTION",
  "MYMCP_DISABLE_SLACK",
  "MYMCP_DISABLE_APIFY",
  "MYMCP_DISABLE_LINEAR",
  "MYMCP_DISABLE_AIRTABLE",
  "MYMCP_DISABLE_BROWSER",
  "MYMCP_DISABLE_COMPOSIO",
  "MYMCP_DISABLE_PAYWALL",
  "MYMCP_DISABLE_VAULT",
  "KEBAB_ENABLED_PACKS",
];

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const k of [...CREDENTIAL_VARS, ...TOGGLE_VARS]) {
    snap[k] = process.env[k];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearAll() {
  for (const k of [...CREDENTIAL_VARS, ...TOGGLE_VARS]) {
    delete process.env[k];
  }
}

async function enabledIds(): Promise<string[]> {
  // Tests mutate process.env directly, bypassing the event bus that
  // normally invalidates the registry cache. Force a reset on every
  // query so the cache never lies.
  __resetRegistryCacheForTests();
  // PERF-01: registry is now async-resolved; await the resolve.
  const reg = await resolveRegistryAsync();
  return reg
    .filter((p) => p.enabled)
    .map((p) => p.manifest.id)
    .sort();
}

describe("registry env-var transitions", () => {
  let savedEnv: EnvSnapshot;

  beforeEach(() => {
    savedEnv = snapshotEnv();
    clearAll();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it("activates skills + admin by default (core always-on connectors)", async () => {
    const enabled = await enabledIds();
    expect(enabled).toContain("skills");
    expect(enabled).toContain("admin");
  });

  it("google activates when all three credentials are set", async () => {
    expect(await enabledIds()).not.toContain("google");
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.GOOGLE_REFRESH_TOKEN = "test-refresh";
    expect(await enabledIds()).toContain("google");
  });

  it("google stays inactive when only partial credentials are set", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    // Missing GOOGLE_REFRESH_TOKEN
    expect(await enabledIds()).not.toContain("google");
  });

  it("github activates with only GITHUB_TOKEN (default repo is optional)", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    expect(await enabledIds()).toContain("github");
  });

  it("notion, slack, linear, airtable, apify activate with single credential", async () => {
    process.env.NOTION_API_KEY = "secret_test";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.AIRTABLE_API_KEY = "pat_test";
    process.env.APIFY_TOKEN = "apify_test";
    const enabled = await enabledIds();
    expect(enabled).toContain("notion");
    expect(enabled).toContain("slack");
    expect(enabled).toContain("linear");
    expect(enabled).toContain("airtable");
    expect(enabled).toContain("apify");
  });

  it("browser activates when all three Browserbase/OpenRouter credentials are set", async () => {
    process.env.BROWSERBASE_API_KEY = "bb_test";
    process.env.BROWSERBASE_PROJECT_ID = "proj_test";
    process.env.OPENROUTER_API_KEY = "or_test";
    expect(await enabledIds()).toContain("browser");
  });

  it("MYMCP_DISABLE_<CONNECTOR>=true force-disables an otherwise active connector", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    expect(await enabledIds()).toContain("github");
    process.env.MYMCP_DISABLE_GITHUB = "true";
    expect(await enabledIds()).not.toContain("github");
  });

  it("KEBAB_ENABLED_PACKS=... limits the set to the listed connectors", async () => {
    process.env.NOTION_API_KEY = "secret_test";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.KEBAB_ENABLED_PACKS = "notion,slack,skills,admin";
    const enabled = await enabledIds();
    expect(enabled).toContain("notion");
    expect(enabled).toContain("slack");
    expect(enabled).toContain("skills");
    expect(enabled).toContain("admin");
    // linear was configured but not in the enabled list
    expect(enabled).not.toContain("linear");
  });

  it("unsetting a credential immediately deactivates the connector", async () => {
    process.env.NOTION_API_KEY = "secret_test";
    expect(await enabledIds()).toContain("notion");
    delete process.env.NOTION_API_KEY;
    expect(await enabledIds()).not.toContain("notion");
  });

  it("connectorCount progression: 0 creds → creds → disable toggle", async () => {
    const baseline = (await enabledIds()).length;
    process.env.NOTION_API_KEY = "secret_test";
    const afterAdd = (await enabledIds()).length;
    expect(afterAdd).toBeGreaterThan(baseline);

    process.env.MYMCP_DISABLE_NOTION = "true";
    const afterDisable = (await enabledIds()).length;
    expect(afterDisable).toBe(baseline);
  });
});
