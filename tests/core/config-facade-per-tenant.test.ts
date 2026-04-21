/**
 * Phase 48 / FACADE-04 — per-tenant setting overrides.
 *
 * Covers:
 *   - getTenantSetting(envKey, kvKey, tenantId?) resolution order
 *     (context → tenant KV → global KV → bootEnv → undefined)
 *   - getInstanceConfigAsync(tenantId) — read-side per-tenant path
 *     (Phase 42 wiring + Phase 48 FACADE-04 confirmation)
 *   - saveInstanceConfig(patch, tenantId) — write-side per-tenant path
 *     (new in Phase 48)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getInstanceConfigAsync,
  saveInstanceConfig,
  resetInstanceConfigCache,
  SETTINGS_KV_KEYS,
} from "../../src/core/config";
import { getTenantKVStore, resetKVStoreCache } from "../../src/core/kv-store";
import { getTenantSetting } from "../../src/core/config-facade";

describe("FACADE-04 — per-tenant setting overrides", () => {
  let tmpDir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mymcp-phase48-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    resetKVStoreCache();
    resetInstanceConfigCache();

    for (const k of [
      "MYMCP_DISPLAY_NAME",
      "MYMCP_TIMEZONE",
      "MYMCP_LOCALE",
      "MYMCP_CONTEXT_PATH",
    ]) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
    resetKVStoreCache();
    resetInstanceConfigCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("Test 1 — getTenantSetting returns tenant-scoped KV value when set", async () => {
    const kv = getTenantKVStore("alpha");
    await kv.set(SETTINGS_KV_KEYS.timezone, "Europe/Paris");

    const val = await getTenantSetting("MYMCP_TIMEZONE", SETTINGS_KV_KEYS.timezone, "alpha");
    expect(val).toBe("Europe/Paris");
  });

  it("Test 2 — getTenantSetting falls back to env when KV is empty", async () => {
    process.env.MYMCP_TIMEZONE = "UTC";
    const val = await getTenantSetting("MYMCP_TIMEZONE", SETTINGS_KV_KEYS.timezone, "beta");
    expect(val).toBe("UTC");
  });

  it("Test 3 — getInstanceConfigAsync(alpha) returns alpha override; beta reads env default", async () => {
    process.env.MYMCP_TIMEZONE = "UTC";
    const alphaKv = getTenantKVStore("alpha");
    await alphaKv.set(SETTINGS_KV_KEYS.timezone, "Europe/Paris");

    resetInstanceConfigCache();
    const alphaCfg = await getInstanceConfigAsync("alpha");
    expect(alphaCfg.timezone).toBe("Europe/Paris");

    resetInstanceConfigCache();
    const betaCfg = await getInstanceConfigAsync("beta");
    expect(betaCfg.timezone).toBe("UTC");
  });

  it("Test 4 — saveInstanceConfig(patch, tenantId) writes to tenant-scoped KV", async () => {
    await saveInstanceConfig({ timezone: "Europe/Berlin" }, "alpha");

    const alphaKv = getTenantKVStore("alpha");
    const stored = await alphaKv.get(SETTINGS_KV_KEYS.timezone);
    expect(stored).toBe("Europe/Berlin");

    // Beta's store is untouched.
    const betaKv = getTenantKVStore("beta");
    const betaStored = await betaKv.get(SETTINGS_KV_KEYS.timezone);
    expect(betaStored).toBeNull();
  });

  it("Test 5 — saveInstanceConfig(patch) without tenantId writes to global", async () => {
    await saveInstanceConfig({ timezone: "Asia/Tokyo" });

    // Tenant KV should NOT reflect it — the global write lands in the
    // unwrapped (null-tenant) namespace, which TenantKVStore('alpha')
    // cannot see.
    const alphaKv = getTenantKVStore("alpha");
    const alphaStored = await alphaKv.get(SETTINGS_KV_KEYS.timezone);
    expect(alphaStored).toBeNull();

    // Global (null-tenant) KV sees it.
    const globalKv = getTenantKVStore(null);
    const globalStored = await globalKv.get(SETTINGS_KV_KEYS.timezone);
    expect(globalStored).toBe("Asia/Tokyo");
  });
});
