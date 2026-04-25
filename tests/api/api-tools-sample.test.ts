/**
 * Tests for POST /api/config/api-tools/sample
 *
 * Covers: missing connection, OK sample, non-JSON body, SSRF guard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetKVStoreCache } from "@/core/kv-store";
import { _resetApiToolsCacheForTests } from "@/connectors/api/store";
import { makeRequest, installAdminToken, adminHeaders } from "@/core/test-utils";

// ── Mock invokeApiTool ─────────────────────────────────────────────────────────

const mockInvoke = vi.fn();

vi.mock("@/connectors/api/lib/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/connectors/api/lib/invoke")>();
  return {
    ...actual,
    invokeApiTool: mockInvoke,
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function loadSampleRoute() {
  const mod = await import("../../app/api/config/api-tools/sample/route");
  return { POST: mod.POST };
}

async function loadConnectionRoute() {
  return import("../../app/api/config/api-connections/route");
}

const validToolDraft = {
  method: "GET" as const,
  pathTemplate: "/v1/widgets",
  arguments: [],
  queryTemplate: {},
  bodyTemplate: "",
  timeoutMs: 5000,
};

describe("POST /api/config/api-tools/sample", () => {
  let tmp: string;
  const origKv = process.env.MYMCP_KV_PATH;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-sample-"));
    process.env.MYMCP_KV_PATH = path.join(tmp, "kv.json");
    resetKVStoreCache();
    _resetApiToolsCacheForTests();
    mockInvoke.mockReset();
  });

  afterEach(async () => {
    if (origKv === undefined) delete process.env.MYMCP_KV_PATH;
    else process.env.MYMCP_KV_PATH = origKv;
    resetKVStoreCache();
    _resetApiToolsCacheForTests();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns 404 when connection not found", async () => {
    const token = installAdminToken("t-sample-test-1234");
    const { POST } = await loadSampleRoute();

    const res = await POST(
      makeRequest("POST", "/api/config/api-tools/sample", {
        headers: adminHeaders(token),
        body: {
          connectionId: "conn_does_not_exist",
          toolDraft: validToolDraft,
          testArgs: {},
        },
      })
    );

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/not found/i);
  });

  it("returns ok:true with status/body/truncated/url on success", async () => {
    const token = installAdminToken("t-sample-ok-1234567890");
    const connRoute = await loadConnectionRoute();

    // Create a real connection in KV
    const createRes = await connRoute.POST(
      makeRequest("POST", "/api/config/api-connections", {
        headers: adminHeaders(token),
        body: {
          name: "Test",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
          headers: {},
          timeoutMs: 5000,
        },
      })
    );
    const createData = await createRes.json();
    expect(createData.ok).toBe(true);
    const connectionId = createData.connection.id;

    // Mock successful invocation
    mockInvoke.mockResolvedValue({
      status: 200,
      ok: true,
      body: '{"id":1,"name":"widget"}',
      truncated: false,
      url: "https://api.example.com/v1/widgets",
    });

    const { POST } = await loadSampleRoute();
    const res = await POST(
      makeRequest("POST", "/api/config/api-tools/sample", {
        headers: adminHeaders(token),
        body: {
          connectionId,
          toolDraft: validToolDraft,
          testArgs: {},
        },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe(200);
    expect(data.body).toBe('{"id":1,"name":"widget"}');
    expect(data.truncated).toBe(false);
    expect(data.url).toBe("https://api.example.com/v1/widgets");
  });

  it("returns ok:true with raw text body when response is not JSON", async () => {
    const token = installAdminToken("t-sample-text-1234567890");
    const connRoute = await loadConnectionRoute();

    const createRes = await connRoute.POST(
      makeRequest("POST", "/api/config/api-connections", {
        headers: adminHeaders(token),
        body: {
          name: "Test",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
          headers: {},
          timeoutMs: 5000,
        },
      })
    );
    const { connection } = await createRes.json();

    mockInvoke.mockResolvedValue({
      status: 200,
      ok: true,
      body: "plain text response",
      truncated: false,
      url: "https://api.example.com/v1/widgets",
    });

    const { POST } = await loadSampleRoute();
    const res = await POST(
      makeRequest("POST", "/api/config/api-tools/sample", {
        headers: adminHeaders(token),
        body: {
          connectionId: connection.id,
          toolDraft: validToolDraft,
          testArgs: {},
        },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.body).toBe("plain text response");
    expect(data.truncated).toBe(false);
  });

  it("returns 400 when invokeApiTool throws SSRF URL rejected error", async () => {
    const token = installAdminToken("t-sample-ssrf-1234567890");
    const connRoute = await loadConnectionRoute();

    const createRes = await connRoute.POST(
      makeRequest("POST", "/api/config/api-connections", {
        headers: adminHeaders(token),
        body: {
          name: "Localhost",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
          headers: {},
          timeoutMs: 5000,
        },
      })
    );
    const { connection } = await createRes.json();

    // SSRF guard throws with this prefix
    mockInvoke.mockRejectedValue(new Error("URL rejected: loopback address not allowed"));

    const { POST } = await loadSampleRoute();
    const res = await POST(
      makeRequest("POST", "/api/config/api-tools/sample", {
        headers: adminHeaders(token),
        body: {
          connectionId: connection.id,
          toolDraft: {
            ...validToolDraft,
            pathTemplate: "http://localhost:8080/internal",
          },
          testArgs: {},
        },
      })
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/URL rejected/);
  });
});
