/**
 * Tests for the transport route's tool registration (SDK v2 / TRU-01):
 * - every tool goes through server.registerTool() with title + annotations
 * - tool without outputSchema → no outputSchema in the registration config
 * - tool with outputSchema → outputSchema present (structuredContent path)
 * - Both registrations produce ToolResult with matching shape
 *
 * We test this by spying on the McpServer methods injected into createMcpHandler.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Spy registry: captures the registration config + callback per tool name
const configs: Record<string, Record<string, unknown>> = {};
const handlerMap: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {};

// Mock mcp-handler to intercept server calls
vi.mock("mcp-handler", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createMcpHandler = (initFn: (server: any) => void) => {
    // Build a fake server and immediately run initFn to populate our spy maps
    const server = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTool: (name: string, config: Record<string, unknown>, cb: any) => {
        configs[name] = config;
        if (typeof cb === "function") handlerMap[name] = cb;
      },
      // Stub out resources/prompts registration
      registerResource: vi.fn(),
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

// v0.20: buildHandler resolves a per-token connector scope. This test isn't
// about scoping, so mock it to "no filter" (full access) — every pack is
// listed, matching pre-v0.20 behavior.
vi.mock("@/core/token-scope", () => ({
  resolveTokenAccess: vi.fn().mockResolvedValue({ kind: "full" }),
  runWithToolAccess: (_ctx: unknown, fn: () => unknown) => fn(),
  getToolAccessContext: () => undefined,
  resolveTokenSkillScope: async () => null,
  resolveCallerMeta: async (tokenId: string | null) => ({ tokenId, label: null, profile: null }),
  runWithCallerMeta: (_meta: unknown, fn: () => unknown) => fn(),
  getCallerMeta: () => null,
  runWithSkillScope: <T>(_t: unknown, fn: () => T) => fn(),
  getCurrentSkillScope: () => null,
  isSkillVisible: () => true,
  isConnectorAllowed: () => true,
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

describe("transport — tool registration", () => {
  beforeEach(async () => {
    // Clear spy maps
    for (const k of Object.keys(configs)) delete configs[k];
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

  it("tool without outputSchema registers without an outputSchema", () => {
    expect(configs["plain_tool"]).toBeDefined();
    expect(configs["plain_tool"]).not.toHaveProperty("outputSchema");
    expect(configs["plain_tool"]?.description).toBe("A tool without outputSchema");
  });

  it("tool with outputSchema registers with an outputSchema", () => {
    expect(configs["schema_tool"]?.outputSchema).toBeDefined();
  });

  it("TRU-01: every tool carries a title and annotations derived from the manifest", () => {
    expect(configs["plain_tool"]?.title).toBe("Plain tool");
    expect(configs["plain_tool"]?.annotations).toEqual({
      title: "Plain tool",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(configs["schema_tool"]?.annotations).toMatchObject({
      title: "Schema tool",
      readOnlyHint: true,
      destructiveHint: false,
    });
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
