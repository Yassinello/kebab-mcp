/**
 * Phase 68 / Plan 05 / Task 1 — CRM bridge skeleton (D-01).
 *
 * Coverage:
 *  - TwentyAdapterSkeleton.writeOutbox writes `unipile:outbox:<audit_id>` with
 *    status='pending' (D-01 hard constraint — phase 68 stops here).
 *  - NO TTL is passed to kv.set — outbox rows are durable until phase 70's
 *    retry cron processes them (D-04).
 *  - crm_log free-form payload roundtrips through JSON.stringify (null,
 *    objects).
 *  - writeOutboxRow free function is equivalent to crmBridge.writeOutbox.
 *  - D-01 source-code static check: the implementation file does NOT contain
 *    `createHmac`, `fetch(`, `UNIPILE_CRM_WEBHOOK_URL`,
 *    `UNIPILE_CRM_WEBHOOK_SECRET`, or `getConfig(` — all of those are phase
 *    70 work and must NOT smuggle in here. This static greps the file from
 *    disk; the test fails the build if any forbidden symbol appears in
 *    runtime code. JSDoc block-comment references (D-02/D-03/D-04 contracts)
 *    are filtered BEFORE the check so the inline documentation does not
 *    trip the guard.
 *  - CrmAdapter interface assignability — TwentyAdapterSkeleton must satisfy
 *    the public contract.
 *
 * Mocks: getContextKVStore via vi.hoisted() — canonical pattern from
 * audit.test.ts (Plan 04). Tenant scoping is fully delegated to
 * getContextKVStore, so the mocked tenant id is fixed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const kvMock = {
    get: vi.fn<(k: string) => Promise<string | null>>(),
    set: vi.fn<(k: string, v: string, ttl?: number) => Promise<void>>(),
    delete: vi.fn<(k: string) => Promise<void>>(),
  };
  return { kvMock };
});

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => hoist.kvMock,
  getCurrentTenantId: () => "test-tenant",
}));

import {
  crmBridge,
  writeOutboxRow,
  TwentyAdapterSkeleton,
  type CrmAdapter,
  type CrmOutboxRow,
} from "../crm-bridge";

describe("TwentyAdapterSkeleton (D-01)", () => {
  beforeEach(() => {
    hoist.kvMock.set.mockReset();
    hoist.kvMock.get.mockReset();
    hoist.kvMock.delete.mockReset();
  });

  it("writes unipile:outbox:<audit_id> with status='pending'", async () => {
    await crmBridge.writeOutbox("audit-123", { crm_log: { contact_id: "c-1" } });
    expect(hoist.kvMock.set).toHaveBeenCalledTimes(1);
    const call = hoist.kvMock.set.mock.calls[0];
    expect(call).toBeDefined();
    const [key, value] = call as [string, string, number?];
    expect(key).toBe("unipile:outbox:audit-123");
    const parsed = JSON.parse(value) as CrmOutboxRow;
    expect(parsed.status).toBe("pending");
    expect(parsed.audit_id).toBe("audit-123");
    expect(parsed.crm_log).toEqual({ contact_id: "c-1" });
    expect(parsed.queued_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("REL-10: outbox rows expire after 30 days (no consumer drains them yet)", async () => {
    await crmBridge.writeOutbox("audit-456", { crm_log: null });
    const args = hoist.kvMock.set.mock.calls[0];
    // KVStore.set(key, value, ttlSeconds?)
    expect(args?.[2]).toBe(30 * 24 * 3600);
  });

  it("handles null crm_log", async () => {
    await crmBridge.writeOutbox("audit-789", { crm_log: null });
    const v = hoist.kvMock.set.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(v) as CrmOutboxRow;
    expect(parsed.crm_log).toBeNull();
  });

  it("writeOutboxRow free function is equivalent to crmBridge.writeOutbox", async () => {
    await writeOutboxRow("audit-abc", { foo: "bar" });
    expect(hoist.kvMock.set).toHaveBeenCalledTimes(1);
    const call = hoist.kvMock.set.mock.calls[0];
    const [key, value] = call as [string, string, number?];
    expect(key).toBe("unipile:outbox:audit-abc");
    const parsed = JSON.parse(value) as CrmOutboxRow;
    expect(parsed.crm_log).toEqual({ foo: "bar" });
    expect(parsed.status).toBe("pending");
  });

  it("queued_at is a valid ISO-8601 UTC timestamp", async () => {
    await crmBridge.writeOutbox("audit-iso", { crm_log: {} });
    const v = hoist.kvMock.set.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(v) as CrmOutboxRow;
    // ISO-8601 with Z suffix (UTC). new Date(...) must round-trip without NaN.
    expect(parsed.queued_at).toMatch(/Z$/);
    expect(Number.isNaN(new Date(parsed.queued_at).getTime())).toBe(false);
  });
});

describe("D-01 hard constraint: skeleton MUST NOT call fetch or hmac", () => {
  // Static check: read the source file and verify forbidden APIs are absent
  // from RUNTIME code. JSDoc / line comments are stripped first so that the
  // file may still DOCUMENT D-02/D-03/D-04 phase 70 contracts (HMAC, webhook
  // url env vars, etc.) without tripping the guard.
  it("source code does not contain runtime references to fetch, createHmac, getConfig, or webhook env vars", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile("src/connectors/unipile/lib/crm-bridge.ts", "utf8");
    // Strip /* ... */ block comments (including JSDoc) and // line comments
    // so commented mentions of phase 70 contracts do not match.
    const codeOnly = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(codeOnly).not.toMatch(/\bcreateHmac\b/);
    expect(codeOnly).not.toMatch(/\bfetch\s*\(/);
    expect(codeOnly).not.toMatch(/UNIPILE_CRM_WEBHOOK_URL/);
    expect(codeOnly).not.toMatch(/UNIPILE_CRM_WEBHOOK_SECRET/);
    expect(codeOnly).not.toMatch(/\bgetConfig\s*\(/);
    expect(codeOnly).not.toMatch(/\btimingSafeEqual\b/);
    // Defensive: ensure node:crypto is NOT imported (no surface for HMAC).
    expect(codeOnly).not.toMatch(/from\s+["']node:crypto["']/);
  });

  it("source code DOES route through getContextKVStore (D-18 tenant prefix)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/connectors/unipile/lib/crm-bridge.ts", "utf8");
    expect(src).toMatch(/\bgetContextKVStore\s*\(/);
    // Defensive: no root-scope getKVStore() escape hatch.
    expect(src).not.toMatch(/\bgetKVStore\s*\(/);
  });

  it("source code documents D-02 / D-03 / D-04 phase 70 contracts in comments", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/connectors/unipile/lib/crm-bridge.ts", "utf8");
    expect(src).toMatch(/D-02/);
    expect(src).toMatch(/D-03/);
    expect(src).toMatch(/D-04/);
  });
});

describe("CrmAdapter interface", () => {
  it("TwentyAdapterSkeleton satisfies CrmAdapter", () => {
    const adapter: CrmAdapter = new TwentyAdapterSkeleton();
    expect(typeof adapter.writeOutbox).toBe("function");
  });

  it("crmBridge singleton is a CrmAdapter", () => {
    const adapter: CrmAdapter = crmBridge;
    expect(typeof adapter.writeOutbox).toBe("function");
  });
});
