/**
 * Tests for request ID propagation.
 *
 * Verifies that:
 * 1. The proxy middleware generates an x-request-id when none is provided
 * 2. The proxy middleware echoes back a client-supplied x-request-id
 * 3. withLogging includes requestId in ToolLog entries
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Proxy middleware tests
// ---------------------------------------------------------------------------

// Minimal mock of NextResponse for proxy.ts
const mockNextResponseHeaders = new Map<string, string>();

vi.mock("next/server", () => {
  class FakeNextResponse {
    public headers: Map<string, string>;
    public cookies = {
      set: vi.fn(),
    };
    constructor(
      public body?: string | null,
      public init?: { status?: number; headers?: Record<string, string> }
    ) {
      this.headers = new Map(Object.entries(init?.headers ?? {}));
    }

    static next(opts?: { request?: { headers?: Headers } }) {
      const res = new FakeNextResponse(null, { status: 200 });
      // Copy any init logic
      void opts;
      return res;
    }

    static redirect(url: URL) {
      const res = new FakeNextResponse(null, { status: 302 });
      void url;
      return res;
    }
  }

  return { NextResponse: FakeNextResponse };
});

function makeNextRequest(overrides: {
  pathname?: string;
  headers?: Record<string, string>;
  searchParams?: Record<string, string>;
}) {
  const { pathname = "/", headers = {}, searchParams = {} } = overrides;
  const url = new URL(`http://localhost:3000${pathname}`);
  for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);

  return {
    headers: new Headers(headers),
    nextUrl: {
      pathname,
      searchParams: url.searchParams,
    },
    url: url.toString(),
    cookies: {
      get: () => undefined,
    },
  };
}

describe("request-id — proxy middleware", () => {
  beforeEach(() => {
    mockNextResponseHeaders.clear();
    // Ensure MCP_AUTH_TOKEN is set so we're not in first-run mode
    process.env.MCP_AUTH_TOKEN = "test-token-for-proxy";
    process.env.ADMIN_AUTH_TOKEN = "test-admin-token-proxy";
  });

  it("generates x-request-id when none is provided", async () => {
    const { proxy } = await import("../../proxy");
    const request = makeNextRequest({ pathname: "/" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await proxy(request as any);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    // UUID v4 format check
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("echoes back client-supplied x-request-id", async () => {
    const { proxy } = await import("../../proxy");
    const clientRequestId = "client-req-abc-123";
    const request = makeNextRequest({
      pathname: "/",
      headers: { "x-request-id": clientRequestId },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await proxy(request as any);
    expect(response.headers.get("x-request-id")).toBe(clientRequestId);
  });
});

// ---------------------------------------------------------------------------
// withLogging requestId propagation tests
// ---------------------------------------------------------------------------

vi.mock("@/core/log-store", () => ({
  getLogStore: () => ({
    append: vi.fn().mockResolvedValue(undefined),
    recent: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("@/core/tracing", () => ({
  startToolSpan: vi.fn().mockReturnValue({ __noop: true }),
  endToolSpan: vi.fn(),
}));

describe("request-id — withLogging", () => {
  it("includes requestId in ToolLog when provided", async () => {
    const { withLogging, getRecentLogs } = await import("@/core/logging");

    const handler = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });

    const wrapped = withLogging("test_tool", handler, "token123", "test-connector", "req-abc-456");
    await wrapped({});

    const logs = getRecentLogs(1);
    expect(logs.length).toBeGreaterThan(0);
    const lastLog = logs[logs.length - 1];
    expect(lastLog.requestId).toBe("req-abc-456");
  });

  it("omits requestId from ToolLog when not provided", async () => {
    const { withLogging, getRecentLogs } = await import("@/core/logging");

    const handler = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });

    const wrapped = withLogging("test_tool_no_rid", handler, "token123", "test-connector");
    await wrapped({});

    const logs = getRecentLogs(5);
    const lastLog = logs[logs.length - 1];
    expect(lastLog.tool).toBe("test_tool_no_rid");
    expect(lastLog.requestId).toBeUndefined();
  });
});
