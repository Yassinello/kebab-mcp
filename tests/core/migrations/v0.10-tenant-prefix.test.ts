/**
 * REL-04 (2026-11 audit): once the JSON completion marker exists, the
 * v0.10 migration must not re-scan the keyspace on every cold start.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
const scanCalls: string[] = [];

vi.mock("@/core/kv-store", () => ({
  getKVStore: () => ({
    kind: "filesystem",
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
    },
  }),
  kvScanAll: async (_kv: unknown, pattern: string) => {
    scanCalls.push(pattern);
    return [];
  },
}));

import {
  runV010TenantPrefixMigration,
  __resetV010MigrationForTests,
} from "@/core/migrations/v0.10-tenant-prefix";

describe("v0.10 tenant-prefix migration marker", () => {
  beforeEach(() => {
    store.clear();
    scanCalls.length = 0;
    __resetV010MigrationForTests();
  });

  it("scans once, writes a JSON marker, then never scans again", async () => {
    await runV010TenantPrefixMigration();
    expect(scanCalls.length).toBeGreaterThan(0);
    const marker = [...store.values()][0]!;
    expect(JSON.parse(marker).status).toBe("completed");

    scanCalls.length = 0;
    __resetV010MigrationForTests(); // simulate a cold start
    await runV010TenantPrefixMigration();
    expect(scanCalls).toHaveLength(0);
  });
});
