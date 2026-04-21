/**
 * Phase 48 / ISO-02 — /api/config/logs tenant selector + scoped query.
 *
 * Covers the 4-way matrix:
 *   - Tenant-scoped admin (x-mymcp-tenant: alpha) → only alpha's bucket.
 *   - Root admin + ?scope=all → union across all tenants.
 *   - Root admin + ?tenant=beta → explicit bucket select.
 *   - Tenant-scoped admin + ?scope=all → ignored (privacy guard).
 *
 * The route is admin-auth-gated in production; the test bypasses
 * withAdminAuth so we only exercise the handler logic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Bypass admin auth for this test.
vi.mock("@/core/with-admin-auth", () => ({
  withAdminAuth: <F extends (...args: unknown[]) => unknown>(handler: F) => handler,
}));

// Force MYMCP_DURABLE_LOGS unset so we always hit the in-memory branch.
vi.stubEnv("MYMCP_DURABLE_LOGS", "");

import { GET } from "../../app/api/config/logs/route";
import { logToolCall, __resetRingBufferForTests, type ToolLog } from "@/core/logging";
import { requestContext } from "@/core/request-context";

function fakeLog(tool: string, status: "success" | "error" = "success"): ToolLog {
  return {
    tool,
    durationMs: 10,
    status,
    timestamp: new Date().toISOString(),
  };
}

function makeReq(headers: Record<string, string> = {}, url = "http://x/api/config/logs") {
  return new Request(url, { method: "GET", headers });
}

async function seedAlphaAndBeta() {
  await requestContext.run({ tenantId: "alpha", credentials: {} }, async () => {
    logToolCall(fakeLog("tool-alpha-1"));
    logToolCall(fakeLog("tool-alpha-2"));
  });
  await requestContext.run({ tenantId: "beta", credentials: {} }, async () => {
    logToolCall(fakeLog("tool-beta-1"));
    logToolCall(fakeLog("tool-beta-2"));
    logToolCall(fakeLog("tool-beta-3"));
  });
}

describe("/api/config/logs — Phase 48 / ISO-02 tenant isolation", () => {
  beforeEach(() => {
    __resetRingBufferForTests();
  });

  it("Test 1 — tenant-scoped admin sees only their own bucket", async () => {
    await seedAlphaAndBeta();

    const ctx = { request: makeReq({ "x-mymcp-tenant": "alpha" }) } as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.source).toBe("memory");
    expect(body.logs).toHaveLength(2);
    expect(body.logs.every((l: ToolLog) => l.tool.startsWith("tool-alpha"))).toBe(true);
  });

  it("Test 2 — root admin + ?scope=all returns union across tenants", async () => {
    await seedAlphaAndBeta();

    const ctx = {
      request: makeReq({}, "http://x/api/config/logs?scope=all"),
    } as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.logs).toHaveLength(5);
    const tools = body.logs.map((l: ToolLog) => l.tool).sort();
    expect(tools).toEqual([
      "tool-alpha-1",
      "tool-alpha-2",
      "tool-beta-1",
      "tool-beta-2",
      "tool-beta-3",
    ]);
  });

  it("Test 3 — root admin + ?tenant=beta returns only beta's bucket", async () => {
    await seedAlphaAndBeta();

    const ctx = {
      request: makeReq({}, "http://x/api/config/logs?tenant=beta"),
    } as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.logs).toHaveLength(3);
    expect(body.logs.every((l: ToolLog) => l.tool.startsWith("tool-beta"))).toBe(true);
  });

  it("Test 4 — tenant-scoped admin + ?scope=all is silently ignored (privacy guard)", async () => {
    await seedAlphaAndBeta();

    const ctx = {
      request: makeReq({ "x-mymcp-tenant": "alpha" }, "http://x/api/config/logs?scope=all"),
    } as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    const body = await res.json();

    expect(body.ok).toBe(true);
    // Scope=all is downgraded; caller sees only their own bucket.
    expect(body.logs).toHaveLength(2);
    expect(body.logs.every((l: ToolLog) => l.tool.startsWith("tool-alpha"))).toBe(true);
  });
});
