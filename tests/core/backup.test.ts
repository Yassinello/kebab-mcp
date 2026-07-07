/**
 * Tests for backup/restore roundtrip and version validation.
 *
 * Phase 42 (TEN-04): `exportBackup` default scope is the current
 * tenant; `opts.scope === "all"` restores the pre-v0.11 full-scan
 * behaviour for root-operator admin flows. BACKUP_VERSION bumped to
 * 2; v1 backups still importable via a compat branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockKV: Record<string, string> = {};

// Raw (unwrapped) store. Used by `getKVStore()` / `scope: "all"` path.
function baseStore() {
  return {
    kind: "filesystem" as const,
    get: vi.fn(async (key: string) => mockKV[key] ?? null),
    set: vi.fn(async (key: string, value: string) => {
      mockKV[key] = value;
    }),
    delete: vi.fn(async (key: string) => {
      delete mockKV[key];
    }),
    list: vi.fn(async (prefix?: string) => {
      const keys = Object.keys(mockKV);
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    }),
  };
}

// Tenant-wrapped store — reads/writes go through `tenant:<id>:<key>`.
function wrappedStore(tenantId: string | null) {
  if (tenantId === null) return baseStore();
  const pk = (k: string) => `tenant:${tenantId}:${k}`;
  return {
    kind: "filesystem" as const,
    get: vi.fn(async (key: string) => mockKV[pk(key)] ?? null),
    set: vi.fn(async (key: string, value: string) => {
      mockKV[pk(key)] = value;
    }),
    delete: vi.fn(async (key: string) => {
      delete mockKV[pk(key)];
    }),
    list: vi.fn(async (prefix?: string) => {
      const full = pk(prefix ?? "");
      return Object.keys(mockKV)
        .filter((k) => k.startsWith(full))
        .map((k) => k.slice(`tenant:${tenantId}:`.length));
    }),
  };
}

vi.mock("@/core/kv-store", async () => {
  const actual = await vi.importActual<typeof import("@/core/kv-store")>("@/core/kv-store");
  return {
    ...actual,
    getKVStore: () => baseStore(),
    getTenantKVStore: (tenantId: string | null) => wrappedStore(tenantId),
  };
});

let mockTenantId: string | null = null;
vi.mock("@/core/request-context", async () => {
  const kvMod = await import("@/core/kv-store");
  // Phase 48 (FACADE-02a): config-facade imports getCredential.
  return {
    getCurrentTenantId: () => mockTenantId,
    getContextKVStore: () => kvMod.getTenantKVStore(mockTenantId),
    getCredential: (envKey: string) => process.env[envKey],
    runWithCredentials: <T>(_creds: Record<string, string>, fn: () => T) => fn(),
    requestContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
  };
});

import { exportBackup, importBackup, BACKUP_VERSION } from "@/core/backup";

describe("backup export/import — v2 baseline", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockKV)) delete mockKV[key];
    mockTenantId = null;
  });

  it("BACKUP_VERSION is 2 (Phase 42 / TEN-04)", () => {
    expect(BACKUP_VERSION).toBe(2);
  });

  it("exports all KV entries (null tenant, default scope)", async () => {
    mockKV["settings:name"] = "TestUser";
    mockKV["webhook:last:stripe"] = '{"payload":"test"}';

    const data = await exportBackup();
    expect(data.version).toBe(BACKUP_VERSION);
    expect(data.exportedAt).toBeTruthy();
    expect(data.scope).toBe("default");
    expect(data.entries["settings:name"]).toBe("TestUser");
    expect(data.entries["webhook:last:stripe"]).toBe('{"payload":"test"}');
  });

  it("roundtrip preserves data", async () => {
    mockKV["key1"] = "value1";
    mockKV["key2"] = "value2";
    mockKV["nested:key"] = '{"deep":true}';

    const exported = await exportBackup();

    // Clear KV
    for (const key of Object.keys(mockKV)) delete mockKV[key];
    expect(Object.keys(mockKV)).toHaveLength(0);

    // Import
    const result = await importBackup(exported);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);

    // Verify
    expect(mockKV["key1"]).toBe("value1");
    expect(mockKV["key2"]).toBe("value2");
    expect(mockKV["nested:key"]).toBe('{"deep":true}');
  });

  it("roundtrip preserves a device's connector scope (v0.20)", async () => {
    // A scoped team token must survive backup/restore with its allowlist
    // intact — a future backup refactor that drops devices:* entries would
    // silently re-grant full access.
    const deviceKey = "devices:abcd1234";
    mockKV[deviceKey] = JSON.stringify({
      label: "Team token",
      createdAt: "2026-07-06T00:00:00.000Z",
      connectors: ["apify", "unipile"],
    });

    const exported = await exportBackup();
    expect(exported.entries[deviceKey]).toBeTruthy();

    for (const key of Object.keys(mockKV)) delete mockKV[key];
    await importBackup(exported);

    const restored = JSON.parse(mockKV[deviceKey]!);
    expect(restored.connectors).toEqual(["apify", "unipile"]);
    expect(restored.label).toBe("Team token");
  });

  it("rejects wrong version", async () => {
    const result = await importBackup({ version: 999, entries: {} });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Unsupported backup version");
  });

  it("rejects non-object input", async () => {
    const result = await importBackup("not an object");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("expected a JSON object");
  });

  it("rejects missing entries", async () => {
    const result = await importBackup({ version: 1 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("missing or malformed entries");
  });

  it("skips non-string values in entries", async () => {
    const result = await importBackup({
      version: 1,
      entries: { valid: "ok", invalid: 123 },
    });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(mockKV["valid"]).toBe("ok");
  });

  it("merge mode (default) preserves existing keys not in backup", async () => {
    mockKV["existing"] = "keep-me";
    mockKV["overwrite"] = "old";

    const result = await importBackup(
      { version: 1, entries: { overwrite: "new", added: "fresh" } },
      { mode: "merge" }
    );
    expect(result.ok).toBe(true);
    expect(mockKV["existing"]).toBe("keep-me");
    expect(mockKV["overwrite"]).toBe("new");
    expect(mockKV["added"]).toBe("fresh");
  });

  it("replace mode deletes keys not in backup", async () => {
    mockKV["existing"] = "remove-me";
    mockKV["keep"] = "old-value";

    const result = await importBackup(
      { version: 1, entries: { keep: "new-value", added: "fresh" } },
      { mode: "replace" }
    );
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(mockKV["existing"]).toBeUndefined();
    expect(mockKV["keep"]).toBe("new-value");
    expect(mockKV["added"]).toBe("fresh");
    expect(result.message).toContain("Replaced");
  });
});

describe("backup — Phase 42 tenant scoping (TEN-04)", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockKV)) delete mockKV[key];
    mockTenantId = null;
  });

  it("export under tenantId alpha returns only alpha's keys with scope=tenant:alpha", async () => {
    mockKV["tenant:alpha:settings:foo"] = "alpha-val";
    mockKV["tenant:beta:settings:foo"] = "beta-val";
    mockKV["bare:key"] = "null-tenant-val";

    mockTenantId = "alpha";
    const data = await exportBackup();
    expect(data.scope).toBe("tenant:alpha");
    // TenantKVStore.list returns keys with the `tenant:alpha:` prefix
    // stripped — matches production behaviour.
    expect(data.entries["settings:foo"]).toBe("alpha-val");
    expect(Object.keys(data.entries)).not.toContain("tenant:beta:settings:foo");
    expect(Object.keys(data.entries)).not.toContain("bare:key");
  });

  it("export with scope=all returns every tenant's keys with scope=all", async () => {
    mockKV["tenant:alpha:a"] = "1";
    mockKV["tenant:beta:b"] = "2";
    mockKV["bare"] = "3";

    const data = await exportBackup({ scope: "all" });
    expect(data.scope).toBe("all");
    expect(data.entries["tenant:alpha:a"]).toBe("1");
    expect(data.entries["tenant:beta:b"]).toBe("2");
    expect(data.entries["bare"]).toBe("3");
  });

  it("import of scope=all backup into a tenant namespace WITHOUT explicit override rejects", async () => {
    const allScopeBackup = {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      scope: "all" as const,
      entries: { "tenant:beta:leak": "leak-value" },
    };

    mockTenantId = "alpha";
    const result = await importBackup(allScopeBackup);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/scope=all/);
  });

  it("import of scope=all backup with explicit scope:all succeeds and writes via raw KV", async () => {
    const allScopeBackup = {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      scope: "all" as const,
      entries: {
        "tenant:alpha:restored": "a",
        "tenant:beta:restored": "b",
      },
    };

    const result = await importBackup(allScopeBackup, { scope: "all" });
    expect(result.ok).toBe(true);
    // Raw KV writes — both tenants' keys land at their full paths.
    expect(mockKV["tenant:alpha:restored"]).toBe("a");
    expect(mockKV["tenant:beta:restored"]).toBe("b");
  });

  it("import of v1 backup into tenant context logs compat warning and succeeds", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockTenantId = "alpha";
    const v1Backup = {
      version: 1,
      entries: { "settings:foo": "legacy-val" },
    };
    const result = await importBackup(v1Backup);
    expect(result.ok).toBe(true);
    // Written into alpha's namespace (tenant-wrapped).
    expect(mockKV["tenant:alpha:settings:foo"]).toBe("legacy-val");

    warnSpy.mockRestore();
  });

  it("fresh export writes version 2", async () => {
    mockKV["sample"] = "v";
    const data = await exportBackup();
    expect(data.version).toBe(2);
  });
});

describe("backup admin tools", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockKV)) delete mockKV[key];
    mockTenantId = null;
  });

  it("mcp_backup_export returns JSON (v2 backups post-TEN-04)", async () => {
    mockKV["test"] = "data";
    const { handleBackupExport } = await import("@/connectors/admin/tools/backup-export");
    const result = await handleBackupExport();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.version).toBe(2);
    expect(parsed.entries.test).toBe("data");
  });

  it("mcp_backup_import writes to KV (v1 compat)", async () => {
    const { handleBackupImport } = await import("@/connectors/admin/tools/backup-import");
    const backup = JSON.stringify({ version: 1, entries: { k: "v" } });
    const result = await handleBackupImport({ data: backup });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(mockKV["k"]).toBe("v");
  });

  it("mcp_backup_import rejects invalid JSON", async () => {
    const { handleBackupImport } = await import("@/connectors/admin/tools/backup-import");
    const result = await handleBackupImport({ data: "not json" });
    expect(result.isError).toBe(true);
  });
});
