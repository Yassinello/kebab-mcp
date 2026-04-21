/**
 * Phase 48 / FACADE-01 — config-facade unit coverage.
 *
 * Covers the synchronous resolution order:
 *   request-context → RUNTIME_READ_THROUGH → bootEnv → undefined
 * and the typed parser helpers + allowlist structural invariants.
 *
 * Async `getTenantSetting()` has its own test file
 * (config-facade-per-tenant.test.ts — Task 9).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getConfig,
  getRequiredConfig,
  getConfigInt,
  getConfigBool,
  getConfigList,
  ALLOWED_DIRECT_ENV_READS,
} from "@/core/config-facade";
import { runWithCredentials } from "@/core/request-context";
import { McpConfigError } from "@/core/errors";

describe("config-facade — FACADE-01 synchronous resolution", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Test 1 — bootEnv is frozen at module load; post-load mutations are invisible", () => {
    // At module load the test harness set MYMCP_TRUST_URL_HOST=1 via
    // vitest.config.ts. That's in bootEnv.
    expect(getConfig("MYMCP_TRUST_URL_HOST")).toBe("1");

    // Mutate process.env directly AFTER module load (vi.stubEnv also
    // mutates process.env under the hood). The bootEnv snapshot does
    // not see it — these keys are NOT in RUNTIME_READ_THROUGH.
    vi.stubEnv("A_FRESH_KEY_AFTER_BOOT", "should-not-appear");
    expect(getConfig("A_FRESH_KEY_AFTER_BOOT")).toBeUndefined();
  });

  it("Test 2 — runWithCredentials override wins over bootEnv", async () => {
    // KEBAB_LOG_BUFFER_PER_TENANT is unlikely to be set in the test boot env.
    const preOverride = getConfig("KEBAB_LOG_BUFFER_PER_TENANT");
    expect(preOverride).toBeUndefined();

    const got = await runWithCredentials({ KEBAB_LOG_BUFFER_PER_TENANT: "override-value" }, () =>
      getConfig("KEBAB_LOG_BUFFER_PER_TENANT")
    );
    expect(got).toBe("override-value");

    // Outside the context, bootEnv path again — still undefined.
    expect(getConfig("KEBAB_LOG_BUFFER_PER_TENANT")).toBeUndefined();
  });

  it("Test 3 — RUNTIME_READ_THROUGH keys read live process.env", () => {
    // VERCEL_URL is intentionally unset in boot env. Mutate and read.
    vi.stubEnv("VERCEL_URL", "my-preview.vercel.app");
    expect(getConfig("VERCEL_URL")).toBe("my-preview.vercel.app");

    vi.stubEnv("VERCEL_URL", "another.vercel.app");
    expect(getConfig("VERCEL_URL")).toBe("another.vercel.app");
  });

  it("Test 4 — getRequiredConfig throws McpConfigError on missing; returns value when set", async () => {
    expect(() => getRequiredConfig("__SURELY_NOT_SET_" + Math.random())).toThrow(McpConfigError);

    const val = await runWithCredentials({ PRESENT_KEY: "hello" }, () =>
      getRequiredConfig("PRESENT_KEY")
    );
    expect(val).toBe("hello");
  });

  it("Test 5 — getConfigInt parses integers; falls back on unset / malformed", async () => {
    // Unset → fallback.
    expect(getConfigInt("__MISSING_INT_KEY", 3000)).toBe(3000);

    // Set to a number.
    const ok = await runWithCredentials({ PORT: "8080" }, () => getConfigInt("PORT", 3000));
    expect(ok).toBe(8080);

    // Malformed → fallback.
    const bad = await runWithCredentials({ PORT: "not-a-number" }, () =>
      getConfigInt("PORT", 3000)
    );
    expect(bad).toBe(3000);

    // Empty string → fallback.
    const empty = await runWithCredentials({ PORT: "" }, () => getConfigInt("PORT", 3000));
    expect(empty).toBe(3000);
  });

  it("Test 6 — getConfigBool accepts 1/true/TRUE; else false (unless fallback)", async () => {
    expect(getConfigBool("__MISSING_BOOL_KEY")).toBe(false);
    expect(getConfigBool("__MISSING_BOOL_KEY", true)).toBe(true);

    for (const truthy of ["1", "true", "TRUE", "True"]) {
      const v = await runWithCredentials({ FLAG: truthy }, () => getConfigBool("FLAG"));
      expect(v).toBe(true);
    }

    for (const falsy of ["0", "false", "no", "off", "FALSE"]) {
      const v = await runWithCredentials({ FLAG: falsy }, () => getConfigBool("FLAG"));
      expect(v).toBe(false);
    }
  });

  it("Test 7 — getConfigList splits on comma, trims, drops empties", async () => {
    expect(getConfigList("__MISSING_LIST_KEY")).toEqual([]);
    expect(getConfigList("__MISSING_LIST_KEY", ["def"])).toEqual(["def"]);

    const v = await runWithCredentials({ ITEMS: "  foo , bar,,baz  ,   " }, () =>
      getConfigList("ITEMS")
    );
    expect(v).toEqual(["foo", "bar", "baz"]);
  });

  it("Test 8 — ALLOWED_DIRECT_ENV_READS is sorted, frozen, non-empty, well-shaped", () => {
    expect(ALLOWED_DIRECT_ENV_READS.length).toBeGreaterThan(0);

    // Frozen.
    expect(Object.isFrozen(ALLOWED_DIRECT_ENV_READS)).toBe(true);

    // Sorted by file path.
    const files = ALLOWED_DIRECT_ENV_READS.map((e) => e.file);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);

    // Every entry has a ≥20 char reason and at least one var.
    for (const entry of ALLOWED_DIRECT_ENV_READS) {
      expect(entry.reason.length).toBeGreaterThanOrEqual(20);
      expect(entry.vars.length).toBeGreaterThan(0);
    }

    // No duplicate file entries.
    const seen = new Set<string>();
    for (const entry of ALLOWED_DIRECT_ENV_READS) {
      expect(seen.has(entry.file)).toBe(false);
      seen.add(entry.file);
    }
  });
});
