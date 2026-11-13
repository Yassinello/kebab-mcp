/** TRU-04 — approval store + signed links (src/core/approvals.ts). */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { kv, config, tenant } = vi.hoisted(() => ({
  kv: { store: new Map<string, string>() },
  config: new Map<string, string>(),
  tenant: { id: null as string | null },
}));

vi.mock("@/core/request-context", () => ({
  getCurrentTenantId: () => tenant.id,
  getContextKVStore: () => ({
    kind: "filesystem",
    get: async (k: string) => kv.store.get(`${tenant.id ?? ""}:${k}`) ?? null,
    set: async (k: string, v: string) => void kv.store.set(`${tenant.id ?? ""}:${k}`, v),
    delete: async (k: string) => void kv.store.delete(`${tenant.id ?? ""}:${k}`),
    list: async () => [],
    setIfNotExists: async (k: string, v: string) => {
      const key = `${tenant.id ?? ""}:${k}`;
      const existing = kv.store.get(key);
      if (existing !== undefined) return { ok: false, existing };
      kv.store.set(key, v);
      return { ok: true };
    },
  }),
}));
vi.mock("@/core/config-facade", () => ({ getConfig: (k: string) => config.get(k) }));
vi.mock("@/core/signing-secret", () => ({ getSigningSecret: async () => "s3cret-s3cret-s3cret" }));

import {
  buildApprovalUrl,
  consume,
  createPreview,
  decide,
  getApprovalMode,
  getPreview,
  getPublicOrigin,
  signApproval,
  verifyApprovalSignature,
} from "../approvals";

const summary = { account: "a1", recipient: "Jane", text: "Hi", details: {} };

beforeEach(() => {
  kv.store.clear();
  config.clear();
  tenant.id = null;
});
afterEach(() => vi.useRealTimers());

describe("getApprovalMode", () => {
  it("defaults to link; only an explicit 'confirm' opts out", () => {
    expect(getApprovalMode()).toBe("link");
    config.set("KEBAB_APPROVAL_MODE", "Confirm");
    expect(getApprovalMode()).toBe("confirm");
    config.set("KEBAB_APPROVAL_MODE", "off");
    expect(getApprovalMode()).toBe("link");
  });
});

describe("lifecycle", () => {
  it("pending → approved → consumed once", async () => {
    const rec = await createPreview({ tool: "t", summary, payload: { args: { text: "Hi" } } });
    expect((await consume(rec.id, "t")).ok).toBe(false); // still pending
    expect((await decide(rec.id, "approve")).ok).toBe(true);
    const first = await consume(rec.id, "t");
    expect(first.ok && first.record.payload).toEqual({ args: { text: "Hi" } });
    const second = await consume(rec.id, "t");
    expect(second).toMatchObject({ ok: false, reason: "already_consumed" });
    // Only a tombstone stays in KV: the text does not outlive execution.
    expect(JSON.stringify([...kv.store.values()])).not.toContain('"Hi"');
    expect(await decide(rec.id, "reject")).toMatchObject({ ok: false, reason: "already_consumed" });
  });

  it("reject deletes; another tool cannot consume", async () => {
    const rec = await createPreview({ tool: "t", summary, payload: {} });
    await decide(rec.id, "approve");
    expect(await consume(rec.id, "other")).toMatchObject({ ok: false, reason: "tool_mismatch" });
    await decide(rec.id, "reject");
    expect(await getPreview(rec.id)).toBeNull();
    expect(await consume(rec.id, "t")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("expires after 15 minutes even when the KV ignores TTLs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
    const rec = await createPreview({ tool: "t", summary, payload: {} });
    vi.setSystemTime(new Date("2026-11-13T10:14:59Z"));
    expect(await getPreview(rec.id)).not.toBeNull();
    vi.setSystemTime(new Date("2026-11-13T10:15:01Z"));
    expect(await getPreview(rec.id)).toBeNull();
    expect(await decide(rec.id, "approve")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("is tenant-scoped", async () => {
    tenant.id = "acme";
    const rec = await createPreview({ tool: "t", summary, payload: {} });
    tenant.id = "other";
    expect(await getPreview(rec.id)).toBeNull();
    tenant.id = "acme";
    expect(await getPreview(rec.id)).not.toBeNull();
  });
});

describe("signed links", () => {
  const id = "a".repeat(32);

  it("verifies only for the same id and tenant", async () => {
    const sig = await signApproval(id, "acme");
    expect(await verifyApprovalSignature(id, "acme", sig)).toBe(true);
    expect(await verifyApprovalSignature(id, null, sig)).toBe(false);
    expect(await verifyApprovalSignature("b".repeat(32), "acme", sig)).toBe(false);
    expect(await verifyApprovalSignature(id, "acme", "0".repeat(64))).toBe(false);
    expect(await verifyApprovalSignature(id, "acme", null)).toBe(false);
    expect(await verifyApprovalSignature("../x", "acme", sig)).toBe(false);
  });

  it("is domain-separated from a bare HMAC of the id", async () => {
    const { createHmac } = await import("node:crypto");
    const bare = createHmac("sha256", "s3cret-s3cret-s3cret").update(id).digest("hex");
    expect(await verifyApprovalSignature(id, null, bare)).toBe(false);
  });

  it("builds absolute URLs from the configured origin", async () => {
    expect(getPublicOrigin()).toBe("http://localhost:3000");
    config.set("VERCEL_URL", "kebab-git-x.vercel.app");
    expect(getPublicOrigin()).toBe("https://kebab-git-x.vercel.app");
    config.set("VERCEL_ENV", "production");
    config.set("VERCEL_PROJECT_PRODUCTION_URL", "kebab.example.com");
    expect(getPublicOrigin()).toBe("https://kebab.example.com");
    config.set("KEBAB_PUBLIC_URL", "https://mcp.me.dev/");
    expect(getPublicOrigin()).toBe("https://mcp.me.dev");

    tenant.id = "acme";
    const url = new URL(await buildApprovalUrl(id));
    expect(url.href.startsWith(`https://mcp.me.dev/approve/${id}?sig=`)).toBe(true);
    expect(url.searchParams.get("t")).toBe("acme");
  });
});
