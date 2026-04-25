/**
 * Tests for the transport route's conditional tool registration:
 * - tool without outputSchema → server.tool() called (legacy)
 * - tool with outputSchema → server.registerTool() called
 * - Both branches produce ToolResult with matching shape
 *
 * We test this by spying on the McpServer methods injected into createMcpHandler.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Spy registry: captures which registration fn was called for which tool name
const registered: Record<string, "tool" | "registerTool"> = {};
const handlerMap: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {};

// Mock mcp-handler to intercept server calls
vi.mock("mcp-handler", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createMcpHandler = (initFn: (server: any) => void) => {
    // Build a fake server and immediately run initFn to populate our spy maps
    const server = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool: (name: string, ...args: any[]) => {
        registered[name] = "tool";
        // last arg is the callback
        const cb = args[args.length - 1];
        if (typeof cb === "function") handlerMap[name] = cb;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTool: (name: string, _config: unknown, cb: any) => {
        registered[name] = "registerTool";
        if (typeof cb === "function") handlerMap[name] = cb;
      },
      // Stub out resources/prompts registration
      resource: vi.fn(),
      registerResource: vi.fn(),
      prompt: vi.fn(),
      registerPrompt: vi.fn(),
    };
    initFn(server);
    // Return a fake handler that does nothing
    return async (_req: Request) => new Response("ok");
  };

  return { createMcpHandler };
});

// Mock registry to inject our controlled tools
const toolWithoutSchema = {
  name: "plain_tool",
  description: "A tool without outputSchema",
  destructive: false,
  schema: {},
  handler: async () => ({
    content: [{ type: "text" as const, text: "plain result" }],
    isError: false,
  }),
};

const toolWithSchema = {
  name: "schema_tool",
  description: "A tool with outputSchema",
  destructive: false,
  schema: {},
  outputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  handler: async () => ({
    content: [{ type: "text" as const, text: '{"id":1}' }],
    isError: false,
    structuredContent: { id: 1 },
  }),
};

vi.mock("@/core/registry", () => ({
  getEnabledPacksLazy: vi.fn().mockResolvedValue([
    {
      manifest: {
        id: "test-pack",
        tools: [toolWithoutSchema, toolWithSchema],
        refresh: undefined,
        registerPrompts: undefined,
        resources: undefined,
      },
    },
  ]),
  logRegistryState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/core/tool-toggles", () => ({
  getDisabledTools: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock("@/core/logging", () => ({
  withLogging: vi.fn((_name: string, fn: (p: Record<string, unknown>) => Promise<unknown>) => fn),
}));

vi.mock("@/core/pipeline", () => ({
  composeRequestPipeline: vi.fn(
    (
      _steps: unknown[],
      handler: (ctx: {
        request: Request;
        tokenId?: string;
        tenantId?: string;
        requestId: string;
      }) => Promise<Response>
    ) => {
      return (req: Request) =>
        handler({ request: req, tokenId: "t1", tenantId: "tenant1", requestId: "req1" });
    }
  ),
  rehydrateStep: vi.fn(),
  firstRunGateStep: vi.fn(),
  authStep: vi.fn(() => vi.fn()),
  rateLimitStep: vi.fn(() => vi.fn()),
  hydrateCredentialsStep: vi.fn(),
}));

vi.mock("@/core/events", () => ({ on: vi.fn() }));
vi.mock("@/core/version", () => ({ VERSION: "test" }));
vi.mock("@/core/resources", () => ({
  registerResources: vi.fn(),
}));

describe("transport — conditional tool registration", () => {
  beforeEach(async () => {
    // Clear spy maps
    for (const k of Object.keys(registered)) delete registered[k];
    for (const k of Object.keys(handlerMap)) delete handlerMap[k];

    // Trigger route module evaluation to populate registered map
    vi.resetModules();
    // Re-import the route to re-run initFn through createMcpHandler
    const { GET } = await import("../../app/api/[transport]/route");
    // Fire a dummy request to trigger buildHandler
    await GET(new Request("https://kebab.example.com/api/mcp", { method: "GET" })).catch(
      () => undefined
    );
  });

  it("tool without outputSchema uses server.tool() (legacy path)", () => {
    expect(registered["plain_tool"]).toBe("tool");
  });

  it("tool with outputSchema uses server.registerTool()", () => {
    expect(registered["schema_tool"]).toBe("registerTool");
  });

  it("both registration paths produce ToolResult with content array", async () => {
    // Both tools' handlers should return a content array
    const plainResult = await handlerMap["plain_tool"]?.({});
    const schemaResult = await handlerMap["schema_tool"]?.({});

    expect(plainResult).toBeDefined();
    expect((plainResult as { content: unknown[] }).content).toBeInstanceOf(Array);

    expect(schemaResult).toBeDefined();
    expect((schemaResult as { content: unknown[] }).content).toBeInstanceOf(Array);
    // schema tool also provides structuredContent
    expect((schemaResult as { structuredContent?: unknown }).structuredContent).toEqual({ id: 1 });
  });
});
