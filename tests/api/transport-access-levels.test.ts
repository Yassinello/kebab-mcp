/**
 * Audit 2026-11 (A1, contract 1) — access levels at the MCP transport.
 *
 * The #1 audit defect: an OAuth client approved with the default (read-only)
 * consent could not save anything during onboarding, silently. Devices now
 * carry an access level:
 *   read   → read-only tools only
 *   memory → + tools that only write the user's own profile/notes/skills
 *   full   → everything (operator tools included)
 * tools/list and tools/call must agree.
 *
 * Drives the real app/api/[transport]/route.ts with the REAL vault, admin,
 * GitHub and Unipile manifests (their flags are what is under test), through
 * the same fake MCP server harness as transport-connector-scope.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const registered = new Set<string>();
const handlerMap: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {};

vi.mock("mcp-handler", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createMcpHandler = (initFn: (server: any) => void) => {
    const server = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTool: (name: string, _config: unknown, cb: any) => {
        registered.add(name);
        if (typeof cb === "function") handlerMap[name] = cb;
      },
      registerResource: vi.fn(),
      registerPrompt: vi.fn(),
    };
    initFn(server);
    return async () => new Response("ok");
  };
  return { createMcpHandler };
});

let access: "read" | "memory" | "full" = "memory";

vi.mock("@/core/registry", () => {
  const pack = (m: { id: string; tools: unknown[] }) => ({
    manifest: { id: m.id, tools: m.tools, registerPrompts: undefined, resources: undefined },
  });
  return {
    // Manifests are loaded at call time (not in the factory) to avoid an
    // import cycle through this mocked module.
    getEnabledPacksLazy: async () => {
      const { vaultConnector } = await import("@/connectors/vault/manifest");
      const { adminConnector } = await import("@/connectors/admin/manifest");
      const { githubConnector } = await import("@/connectors/github/manifest");
      const { unipileConnector } = await import("@/connectors/unipile/manifest");
      return [
        pack(vaultConnector),
        pack(adminConnector),
        pack(githubConnector),
        pack(unipileConnector),
      ];
    },
    logRegistryState: vi.fn().mockResolvedValue(undefined),
    getKnownConnectorIds: () => ["vault", "admin", "github", "unipile"],
    CORE_CONNECTOR_IDS: ["skills", "admin"],
  };
});

vi.mock("@/core/tool-toggles", () => ({
  getDisabledTools: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock("@/core/token-scope", () => ({
  resolveTokenAccess: async () => ({ kind: "full" }),
  runWithToolAccess: (_ctx: unknown, fn: () => unknown) => fn(),
  getToolAccessContext: () => undefined,
  resolveTokenSkillScope: async () => null,
  resolveCallerMeta: async (tokenId: string | null) => ({ tokenId }),
  runWithCallerMeta: (_meta: unknown, fn: () => unknown) => fn(),
  getCallerMeta: () => ({
    tokenId: "0a1b2c3d",
    label: "Claude",
    profile: null,
    access,
    writeAllowed: access === "full",
  }),
  runWithSkillScope: <T>(_t: unknown, fn: () => T) => fn(),
  getCurrentSkillScope: () => null,
  isSkillVisible: () => true,
  isConnectorAllowed: () => true,
}));

vi.mock("@/core/logging", async (orig) => ({
  ...((await orig()) as object),
  withLogging: vi.fn((_name: string, fn: (p: Record<string, unknown>) => Promise<unknown>) => fn),
}));

vi.mock("@/core/pipeline", () => ({
  composeRequestPipeline: vi.fn(
    (_steps: unknown[], handler: (ctx: Record<string, unknown>) => Promise<Response>) =>
      (req: Request) =>
        handler({ request: req, tokenId: "0a1b2c3d", tenantId: null, requestId: "req1" })
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
vi.mock("@/core/usage", async (orig) => ({
  ...((await orig()) as object),
  recordToolCall: vi.fn(),
}));

async function list(level: "read" | "memory" | "full"): Promise<Set<string>> {
  access = level;
  registered.clear();
  for (const k of Object.keys(handlerMap)) delete handlerMap[k];
  vi.resetModules();
  const { GET } = await import("../../app/api/[transport]/route");
  await GET(new Request("https://kebab.example.com/api/mcp", { method: "GET" })).catch(
    () => undefined
  );
  return new Set(registered);
}

const MEMORY_TOOLS = ["vault_write", "vault_append", "save_article", "vault_move"];
const FULL_ONLY = ["vault_delete", "linkedin_send_message", "github_create_issue"];
const ADMIN_ONLY = ["mcp_logs", "mcp_cache_evict"];

describe("transport — access levels", () => {
  beforeEach(() => {
    access = "memory";
  });

  it("memory: sees the memory-write tools, not deletes, sends, issues or operator tools", async () => {
    const tools = await list("memory");
    for (const t of MEMORY_TOOLS) expect(tools.has(t), t).toBe(true);
    for (const t of [...FULL_ONLY, ...ADMIN_ONLY]) expect(tools.has(t), t).toBe(false);
    expect(tools.has("vault_read")).toBe(true);
  });

  it("read: sees no tool that changes anything", async () => {
    const tools = await list("read");
    for (const t of [...MEMORY_TOOLS, ...FULL_ONLY, ...ADMIN_ONLY]) {
      expect(tools.has(t), t).toBe(false);
    }
    expect(tools.has("vault_read")).toBe(true);
    expect(tools.has("vault_search")).toBe(true);
  });

  it("full: sees every tool", async () => {
    const tools = await list("full");
    for (const t of [...MEMORY_TOOLS, ...FULL_ONLY, ...ADMIN_ONLY, "vault_read"]) {
      expect(tools.has(t), t).toBe(true);
    }
  });

  it("calls are refused consistently with the listing", async () => {
    // Listed at full, then the same request's caller is "memory" / "read".
    await list("full");
    access = "memory";
    for (const t of [...FULL_ONLY, ...ADMIN_ONLY]) {
      const res = (await handlerMap[t]!({})) as { isError?: boolean; content: { text: string }[] };
      expect(res.isError, t).toBe(true);
      expect(res.content[0]!.text).toMatch(/Kebab House → Devices/);
    }
    access = "read";
    for (const t of MEMORY_TOOLS) {
      const res = (await handlerMap[t]!({})) as { isError?: boolean; content: { text: string }[] };
      expect(res.isError, t).toBe(true);
      expect(res.content[0]!.text).toMatch(/can only read/);
    }
  });

  it("every listed tool at each level is one the gate allows (no drift)", async () => {
    const { isToolAllowedForAccess } = await import("@/core/tool-access");
    const { vaultConnector } = await import("@/connectors/vault/manifest");
    const { adminConnector } = await import("@/connectors/admin/manifest");
    const all = [...vaultConnector.tools, ...adminConnector.tools];
    for (const level of ["read", "memory", "full"] as const) {
      const tools = await list(level);
      for (const t of all)
        expect(tools.has(t.name), `${level}:${t.name}`).toBe(isToolAllowedForAccess(t, level));
    }
  });
});
