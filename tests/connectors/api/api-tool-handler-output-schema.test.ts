import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApiToolDefinition } from "@/connectors/api/manifest";
import type { ApiTool } from "@/connectors/api/store";

// ── Mocks ────────────────────────────────────────────────────────────────────
// All factories must NOT reference top-level variables (hoisting constraint).

const mockGetApiConnection = vi.fn();
const mockInvoke = vi.fn();

vi.mock("@/connectors/api/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/connectors/api/store")>();
  return {
    ...actual,
    getApiConnection: (...args: unknown[]) => mockGetApiConnection(...args),
  };
});

vi.mock("@/connectors/api/lib/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/connectors/api/lib/invoke")>();
  return {
    ...actual,
    invokeApiTool: (...args: unknown[]) => mockInvoke(...args),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockConnection = {
  id: "conn_test",
  name: "Test Connection",
  baseUrl: "https://api.example.com",
  auth: { type: "none" as const },
  headers: {},
  timeoutMs: 30000,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

function makeTool(overrides: Partial<ApiTool> = {}): ApiTool {
  return {
    id: "tool_001",
    connectionId: "conn_test",
    name: "test_tool",
    description: "test",
    method: "GET",
    pathTemplate: "/test",
    arguments: [],
    queryTemplate: {},
    bodyTemplate: "",
    readOrWrite: "read",
    destructive: false,
    timeoutMs: 30000,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildApiToolDefinition — outputSchema / structuredContent", () => {
  beforeEach(() => {
    mockGetApiConnection.mockReset();
    mockInvoke.mockReset();
    mockGetApiConnection.mockResolvedValue(mockConnection);
  });

  it("tool without outputSchema → ToolResult has no structuredContent", async () => {
    mockInvoke.mockResolvedValue({
      status: 200,
      ok: true,
      body: '{"id":1}',
      truncated: false,
      url: "https://api.example.com/test",
    });

    const tool = makeTool(); // no outputSchema
    const def = buildApiToolDefinition(tool);
    const result = await def.handler({});

    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]?.text).toContain("HTTP 200");
  });

  it("tool with outputSchema + valid JSON body → ToolResult has structuredContent", async () => {
    mockInvoke.mockResolvedValue({
      status: 200,
      ok: true,
      body: '{"id":1,"name":"widget"}',
      truncated: false,
      url: "https://api.example.com/test",
    });

    const tool = makeTool({
      outputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    });
    const def = buildApiToolDefinition(tool);
    const result = await def.handler({});

    expect(result.structuredContent).toEqual({ id: 1, name: "widget" });
    expect(result.isError).toBe(false);
  });

  it("tool with outputSchema + non-JSON body → ToolResult has no structuredContent (silent fallback)", async () => {
    mockInvoke.mockResolvedValue({
      status: 200,
      ok: true,
      body: "plain text response, not JSON",
      truncated: false,
      url: "https://api.example.com/test",
    });

    const tool = makeTool({
      outputSchema: { type: "object" },
    });
    const def = buildApiToolDefinition(tool);
    const result = await def.handler({});

    expect(result.structuredContent).toBeUndefined();
    expect(result.isError).toBe(false);
  });

  it("tool with outputSchema + truncated=true → ToolResult has no structuredContent (skip)", async () => {
    mockInvoke.mockResolvedValue({
      status: 200,
      ok: true,
      body: '{"id":1}',
      truncated: true, // truncated — skip structuredContent
      url: "https://api.example.com/test",
    });

    const tool = makeTool({
      outputSchema: { type: "object" },
    });
    const def = buildApiToolDefinition(tool);
    const result = await def.handler({});

    expect(result.structuredContent).toBeUndefined();
  });

  it("tool with outputSchema + HTTP 500 + valid JSON body → structuredContent present (design choice: parse regardless of HTTP status)", async () => {
    // Design choice: we attach structuredContent as long as outputSchema is set,
    // body is valid JSON, and not truncated — regardless of HTTP status code.
    // isError=true is set independently. This allows callers to inspect structured
    // error payloads from APIs that return JSON error bodies on 5xx.
    mockInvoke.mockResolvedValue({
      status: 500,
      ok: false,
      body: '{"error":"internal","code":500}',
      truncated: false,
      url: "https://api.example.com/test",
    });

    const tool = makeTool({
      outputSchema: { type: "object" },
    });
    const def = buildApiToolDefinition(tool);
    const result = await def.handler({});

    // isError is true because result.ok is false
    expect(result.isError).toBe(true);
    // structuredContent is populated (JSON parsed successfully, not truncated)
    expect(result.structuredContent).toEqual({ error: "internal", code: 500 });
  });
});
