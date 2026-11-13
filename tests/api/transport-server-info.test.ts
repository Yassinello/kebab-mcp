/**
 * Kebab House phase 0 / BRD-04 — the MCP `serverInfo` announced in the
 * `initialize` response carries the product display name "Kebab House"
 * (not the technical "Kebab MCP" name kept for logs and the repo).
 *
 * Same fake-mcp-server harness as transport-output-schema.test.ts: we
 * capture the server options the route hands to createMcpHandler.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedServerOptions: { serverInfo?: { name?: string; version?: string } } | undefined;

vi.mock("mcp-handler", () => {
  const createMcpHandler = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initFn: (server: any) => void,
    serverOptions?: { serverInfo?: { name?: string; version?: string } }
  ) => {
    capturedServerOptions = serverOptions;
    initFn({
      tool: vi.fn(),
      registerTool: vi.fn(),
      resource: vi.fn(),
      registerResource: vi.fn(),
      prompt: vi.fn(),
      registerPrompt: vi.fn(),
    });
    return async (_req: Request) => new Response("ok");
  };
  return { createMcpHandler };
});

vi.mock("@/core/registry", () => ({
  getEnabledPacksLazy: vi.fn().mockResolvedValue([]),
  logRegistryState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/core/tool-toggles", () => ({
  getDisabledTools: vi.fn().mockResolvedValue(new Set()),
}));

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
vi.mock("@/core/version", () => ({ VERSION: "9.9.9-test" }));
vi.mock("@/core/resources", () => ({ registerResources: vi.fn() }));

describe("transport — MCP serverInfo (BRD-04)", () => {
  beforeEach(async () => {
    capturedServerOptions = undefined;
    vi.resetModules();
    const { GET } = await import("../../app/api/[transport]/route");
    await GET(new Request("https://kebab.example.com/api/mcp", { method: "GET" })).catch(
      () => undefined
    );
  });

  it('announces the server as "Kebab House"', () => {
    expect(capturedServerOptions?.serverInfo?.name).toBe("Kebab House");
  });

  it("keeps reporting the package version", () => {
    expect(capturedServerOptions?.serverInfo?.version).toBe("9.9.9-test");
  });
});
