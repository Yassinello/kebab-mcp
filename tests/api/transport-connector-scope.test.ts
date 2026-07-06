/**
 * v0.20 — end-to-end connector scoping at the transport route.
 *
 * Drives the real app/api/[transport]/route.ts buildHandler through the
 * same fake-mcp-server harness as transport-output-schema.test.ts, and
 * asserts both filter points:
 *   - listing: out-of-scope connectors' tools are never registered
 *   - invocation: a captured handler for an out-of-scope tool returns isError
 *
 * The connector scope is controlled by mocking @/core/token-scope so the
 * test is deterministic regardless of KV/device state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const registered: Record<string, "tool" | "registerTool"> = {};
const handlerMap: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {};

vi.mock("mcp-handler", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createMcpHandler = (initFn: (server: any) => void) => {
    const server = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool: (name: string, ...args: any[]) => {
        registered[name] = "tool";
        const cb = args[args.length - 1];
        if (typeof cb === "function") handlerMap[name] = cb;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTool: (name: string, _config: unknown, cb: any) => {
        registered[name] = "registerTool";
        if (typeof cb === "function") handlerMap[name] = cb;
      },
      resource: vi.fn(),
      registerResource: vi.fn(),
      prompt: vi.fn(),
      registerPrompt: vi.fn(),
    };
    initFn(server);
    return async (_req: Request) => new Response("ok");
  };
  return { createMcpHandler };
});

const apifyTool = {
  name: "apify_run",
  description: "team scraping tool",
  destructive: false,
  schema: {},
  handler: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
};
const googleTool = {
  name: "google_search_files",
  description: "personal drive tool",
  destructive: false,
  schema: {},
  handler: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
};

vi.mock("@/core/registry", () => ({
  getEnabledPacksLazy: vi.fn().mockResolvedValue([
    {
      manifest: {
        id: "apify",
        tools: [apifyTool],
        registerPrompts: undefined,
        resources: undefined,
      },
    },
    {
      manifest: {
        id: "google",
        tools: [googleTool],
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

// Scope control. `scopeAtListing` drives what resolveTokenConnectorScope
// returns; isConnectorAllowed keeps real semantics. A separate
// `denyAtInvocation` set lets a test register a tool (listing sees it in
// scope) then reject it at invocation — proving the defense-in-depth guard
// fires independently, as it would across separate HTTP requests when the
// operator tightens the token's scope mid-session.
let scopeAtListing: Set<string> | null = new Set(["apify"]);
let denyAtInvocation: Set<string> = new Set();
vi.mock("@/core/token-scope", () => ({
  resolveTokenConnectorScope: vi.fn().mockImplementation(async () => scopeAtListing),
  isConnectorAllowed: (scope: Set<string> | null, id: string) => {
    if (denyAtInvocation.has(id)) return false;
    return scope === null ? true : scope.has(id);
  },
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
        handler({ request: req, tokenId: "teamtoken", tenantId: "tenant1", requestId: "req1" });
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
vi.mock("@/core/resources", () => ({ registerResources: vi.fn() }));

async function buildRoute() {
  for (const k of Object.keys(registered)) delete registered[k];
  for (const k of Object.keys(handlerMap)) delete handlerMap[k];
  vi.resetModules();
  const { GET } = await import("../../app/api/[transport]/route");
  await GET(new Request("https://kebab.example.com/api/mcp", { method: "GET" })).catch(
    () => undefined
  );
}

describe("transport — per-token connector scope", () => {
  beforeEach(() => {
    scopeAtListing = new Set(["apify"]);
    denyAtInvocation = new Set();
  });

  it("registers in-scope connector tools (listing)", async () => {
    await buildRoute();
    expect(registered["apify_run"]).toBeDefined();
  });

  it("does NOT register out-of-scope connector tools (listing)", async () => {
    await buildRoute();
    expect(registered["google_search_files"]).toBeUndefined();
  });

  it("in-scope tool invocation succeeds", async () => {
    await buildRoute();
    const result = await handlerMap["apify_run"]?.({});
    expect((result as { isError?: boolean }).isError).toBe(false);
  });

  it("rejects invocation of a tool whose connector left scope after listing (defense-in-depth)", async () => {
    // Listing sees full access → both tools register + capture handlers.
    scopeAtListing = null;
    await buildRoute();
    expect(handlerMap["google_search_files"]).toBeDefined();

    // Operator tightens the token's scope; a subsequent tools/call for the
    // now-out-of-scope tool must be rejected by the invocation guard.
    denyAtInvocation = new Set(["google"]);
    const result = await handlerMap["google_search_files"]?.({});
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/not in this token's connector scope/);
  });
});
