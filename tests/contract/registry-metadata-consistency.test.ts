/**
 * tests/contract/registry-metadata-consistency.test.ts
 *
 * Contract test: ensures that the STATIC metadata on `ALL_CONNECTOR_LOADERS`
 * stays consistent with the ACTUAL manifest returned by each loader.
 *
 * Why this test exists
 * --------------------
 * PERF-01 (v0.11 Phase 43) split the connector registry into a static
 * loader table + lazy-imported manifests. Two sources of truth now
 * coexist:
 *
 *   1. `ALL_CONNECTOR_LOADERS[i]` — static { id, label, description,
 *      requiredEnvVars, toolCount } used for gate decisions + disabled-card
 *      UI teasers ("18 tools available when you enable Google") without
 *      needing to load the heavy manifest.
 *   2. `await entry.loader()` — full `ConnectorManifest` with the real
 *      `tools[]` array + `isActive` predicate.
 *
 * If a maintainer adds a tool to a manifest WITHOUT bumping the loader
 * entry's `toolCount`, the disabled-card UI lies to the user. This test
 * catches that drift at CI time.
 *
 * Why loading every manifest is fine here
 * ---------------------------------------
 * This test INTENTIONALLY pays the full load cost that PERF-01 was
 * designed to avoid at runtime. The contract-test is a one-time CI cost:
 * we accept it to guarantee the lazy metadata stays honest. Production
 * lambdas never execute this code.
 */

import { describe, it, expect } from "vitest";
import { ALL_CONNECTOR_LOADERS } from "@/core/registry";

// This suite intentionally awaits every connector's `loader()` — the only
// test we have that loads all 14 manifests in one pass. On a cold vitest
// worker that means ~13s of tsx transform + module init. The 15s default
// testTimeout can flake under parallel load; 45s gives headroom.
describe("registry loader metadata vs loaded manifest consistency", () => {
  it("every loader entry's id matches the loaded manifest.id", async () => {
    for (const entry of ALL_CONNECTOR_LOADERS) {
      const manifest = await entry.loader();
      expect(manifest.id, `loader entry "${entry.id}"`).toBe(entry.id);
    }
  }, 45_000);

  it("every loader entry's requiredEnvVars matches the loaded manifest.requiredEnvVars", async () => {
    for (const entry of ALL_CONNECTOR_LOADERS) {
      const manifest = await entry.loader();
      expect(
        manifest.requiredEnvVars.slice().sort(),
        `requiredEnvVars mismatch for "${entry.id}"`
      ).toEqual(entry.requiredEnvVars.slice().sort());
    }
  }, 45_000);

  it("every loader entry's toolCount matches the loaded manifest.tools.length", async () => {
    // Skills is user-defined: the sync tool-list reads from disk/KV and
    // varies per deploy. The loader's static toolCount=0 is a stub; the
    // actual manifest reports whatever is in the current skill store.
    // We skip the equality check for "skills" to avoid making the
    // contract test dependent on local disk state.
    const DYNAMIC_TOOL_COUNT = new Set(["skills"]);
    for (const entry of ALL_CONNECTOR_LOADERS) {
      if (DYNAMIC_TOOL_COUNT.has(entry.id)) continue;
      const manifest = await entry.loader();
      expect(
        manifest.tools.length,
        `toolCount mismatch for "${entry.id}" — static says ${entry.toolCount}, manifest reports ${manifest.tools.length}`
      ).toBe(entry.toolCount);
    }
  }, 45_000);

  it("loader entries' labels are non-empty + stable across loads (cache honored)", async () => {
    for (const entry of ALL_CONNECTOR_LOADERS) {
      expect(entry.label.length, `empty label for "${entry.id}"`).toBeGreaterThan(0);
      const m1 = await entry.loader();
      const m2 = await entry.loader();
      // Node's ES module cache makes `import()` return the same module
      // object on subsequent loads — so m1.tools === m2.tools by identity.
      // Worst case (re-import under bundler): semantic equality still holds.
      expect(m1.tools.length).toBe(m2.tools.length);
    }
  }, 45_000);
});
