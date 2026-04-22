/**
 * Unit tests for the pack registry.
 * Tests enable/disable logic, MYMCP_DISABLE_*, KEBAB_ENABLED_PACKS.
 *
 * Run: npx tsx scripts/registry-test.ts
 *
 * PERF-01: migrated from the old `resolveRegistry()` sync API to the new
 * `resolveRegistryAsync()` — the registry now lazy-loads connector
 * manifests on first async resolve. Each test awaits the registry.
 */

import { resolveRegistryAsync, __resetRegistryCacheForTests } from "../src/core/registry";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${name}`);
    failed++;
  }
}

// Save original env
const originalEnv = { ...process.env };

function resetEnv() {
  // Clear all MYMCP/pack-related env vars
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("MYMCP_") ||
      key.startsWith("GOOGLE_") ||
      key.startsWith("GITHUB_") ||
      key.startsWith("BROWSERBASE_") ||
      key.startsWith("OPENROUTER_") ||
      key.startsWith("SLACK_") ||
      key.startsWith("NOTION_")
    ) {
      delete process.env[key];
    }
  }
  // NIT-12 root cause: this script mutates process.env directly and
  // does NOT emit("env.changed"), so the registry cache (added in v0.5
  // phase 15) was retained across tests and every test after the first
  // saw stale state. Drop the cache explicitly via the test escape hatch.
  __resetRegistryCacheForTests();
}

function setGoogleEnv() {
  process.env.GOOGLE_CLIENT_ID = "test";
  process.env.GOOGLE_CLIENT_SECRET = "test";
  process.env.GOOGLE_REFRESH_TOKEN = "test";
}

function setVaultEnv() {
  process.env.GITHUB_PAT = "test";
  process.env.GITHUB_REPO = "test/test";
}

// --- Tests ---

async function run() {
  console.log("[Registry Test]\n");

  console.log("Test 1: Admin pack always active");
  resetEnv();
  {
    const reg = await resolveRegistryAsync();
    const admin = reg.find((p) => p.manifest.id === "admin");
    assert(admin !== undefined, "admin pack exists");
    assert(admin!.enabled === true, "admin pack is enabled");
    assert(admin!.reason === "active", "reason is 'active'");
  }

  console.log("\nTest 2: Google pack disabled when env vars missing");
  resetEnv();
  {
    const reg = await resolveRegistryAsync();
    const google = reg.find((p) => p.manifest.id === "google");
    assert(google!.enabled === false, "google pack is disabled");
    assert(google!.reason.includes("missing env"), "reason mentions missing env");
  }

  console.log("\nTest 3: Google pack enabled when all env vars present");
  resetEnv();
  setGoogleEnv();
  {
    const reg = await resolveRegistryAsync();
    const google = reg.find((p) => p.manifest.id === "google");
    assert(google!.enabled === true, "google pack is enabled");
    assert(google!.reason === "active", "reason is 'active'");
  }

  console.log("\nTest 4: MYMCP_DISABLE_GOOGLE force-disables");
  resetEnv();
  setGoogleEnv();
  process.env.MYMCP_DISABLE_GOOGLE = "true";
  {
    const reg = await resolveRegistryAsync();
    const google = reg.find((p) => p.manifest.id === "google");
    assert(google!.enabled === false, "google pack is disabled");
    assert(google!.reason.includes("MYMCP_DISABLE_GOOGLE"), "reason mentions disable var");
  }

  console.log("\nTest 5: KEBAB_ENABLED_PACKS restricts to listed packs only");
  resetEnv();
  setGoogleEnv();
  setVaultEnv();
  process.env.KEBAB_ENABLED_PACKS = "vault,admin";
  {
    const reg = await resolveRegistryAsync();
    const google = reg.find((p) => p.manifest.id === "google");
    const vault = reg.find((p) => p.manifest.id === "vault");
    const admin = reg.find((p) => p.manifest.id === "admin");
    assert(google!.enabled === false, "google pack disabled (not in list)");
    assert(google!.reason.includes("KEBAB_ENABLED_PACKS"), "reason mentions enabled list");
    assert(vault!.enabled === true, "vault pack enabled (in list + creds)");
    assert(admin!.enabled === true, "admin pack enabled (in list)");
  }

  console.log("\nTest 6: KEBAB_ENABLED_PACKS + missing creds = disabled");
  resetEnv();
  process.env.KEBAB_ENABLED_PACKS = "google,admin";
  {
    const reg = await resolveRegistryAsync();
    const google = reg.find((p) => p.manifest.id === "google");
    assert(google!.enabled === false, "google disabled (in list but no creds)");
    assert(google!.reason.includes("missing env"), "reason is missing env, not list");
  }

  console.log("\nTest 7: All packs have manifests with tools");
  resetEnv();
  {
    // Skills pack is user-defined and intentionally has 0 tools until skills are authored.
    // Post-PERF-01: disabled packs synthesize a stub manifest with tools: []; skip the
    // tools-length check for disabled packs (the static `entry.toolCount` is the
    // authoritative surface for disabled-card UI; covered by the metadata-consistency
    // contract test).
    const DYNAMIC_EMPTY_PACKS = new Set(["skills"]);
    const reg = await resolveRegistryAsync();
    for (const pack of reg) {
      if (!DYNAMIC_EMPTY_PACKS.has(pack.manifest.id) && pack.enabled) {
        assert(
          pack.manifest.tools.length > 0,
          `${pack.manifest.id} has ${pack.manifest.tools.length} tools`
        );
      }
      assert(pack.manifest.id.length > 0, `${pack.manifest.id} has id`);
      assert(pack.manifest.label.length > 0, `${pack.manifest.id} has label`);
    }
  }

  // Restore env
  Object.assign(process.env, originalEnv);

  console.log(`\n[Registry Test] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("[Registry Test] unhandled error:", err);
  process.exit(1);
});
