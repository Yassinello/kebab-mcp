/**
 * Audit 2026-11 (A6) — usage counters recorded by the MCP transport:
 *   - skill_template_install is not a skill named "template_install";
 *   - skill_load counts the canonical library name, not the raw argument;
 *   - a failed call (isError or a JSON `error` body) is not counted;
 *   - "notes" counts vault_write only when it created a note.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const handlerMap: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {};
const recorded: Array<Record<string, unknown>> = [];

vi.mock("mcp-handler", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createMcpHandler = (initFn: (server: any) => void) => {
    const server = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTool: (name: string, _config: unknown, cb: any) => {
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

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const tool = (name: string, result: unknown, extra: Record<string, unknown> = {}) => ({
  name,
  description: name,
  destructive: false,
  schema: {},
  handler: async () => result,
  ...extra,
});

vi.mock("@/core/registry", () => ({
  getEnabledPacksLazy: vi.fn().mockResolvedValue([
    {
      manifest: {
        id: "skills",
        tools: [
          tool("skill_load", text("# Skill: meeting-prep\n\nSteps")),
          tool("skill_read_file", text("file body")),
          tool("skill_weekly_review", text("rendered")),
        ],
      },
    },
    {
      manifest: {
        id: "context",
        tools: [
          tool("skill_template_install", text(JSON.stringify({ ok: true, skill: "x" })), {
            destructive: true,
            memoryWrite: true,
          }),
          tool("my_context_update", text(JSON.stringify({ ok: true })), {
            destructive: true,
            memoryWrite: true,
          }),
        ],
      },
    },
    {
      manifest: {
        id: "vault",
        tools: [
          tool("vault_write", text(JSON.stringify({ success: true, action: "created" })), {
            destructive: true,
            memoryWrite: true,
          }),
          tool("vault_append", text(JSON.stringify({ error: "note not found" })), {
            destructive: true,
            memoryWrite: true,
          }),
        ],
      },
    },
  ]),
  logRegistryState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/core/tool-toggles", () => ({ getDisabledTools: vi.fn().mockResolvedValue(new Set()) }));
vi.mock("@/core/token-scope", () => ({
  resolveTokenAccess: async () => ({ kind: "full" }),
  runWithToolAccess: (_ctx: unknown, fn: () => unknown) => fn(),
  getToolAccessContext: () => undefined,
  resolveTokenSkillScope: async () => null,
  resolveCallerMeta: async (tokenId: string | null) => ({ tokenId }),
  runWithCallerMeta: (_meta: unknown, fn: () => unknown) => fn(),
  getCallerMeta: () => ({ tokenId: "0a1b2c3d", label: "Claude", profile: null, access: "full" }),
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
  recordToolCall: (u: Record<string, unknown>) => recorded.push(u),
}));

async function call(name: string, params: Record<string, unknown> = {}) {
  vi.resetModules();
  const { GET } = await import("../../app/api/[transport]/route");
  await GET(new Request("https://kebab.example.com/api/mcp", { method: "GET" })).catch(
    () => undefined
  );
  await handlerMap[name]!(params);
  return recorded.at(-1);
}

beforeEach(() => {
  recorded.length = 0;
});

describe("transport usage counters (A6)", () => {
  it("skill_load counts the loaded skill's canonical name, not the raw argument", async () => {
    expect(await call("skill_load", { name: "Meeting Prep" })).toMatchObject({
      tool: "skill_load",
      skill: "meeting-prep",
    });
  });

  it("legacy per-skill tools count; skill_read_file and template tools do not", async () => {
    expect(await call("skill_weekly_review")).toMatchObject({ skill: "weekly-review" });
    expect(await call("skill_read_file", { name: "x", path: "y" })).toMatchObject({ skill: null });
    expect(await call("skill_template_install", { name: "x" })).toMatchObject({ skill: null });
  });

  it("does not count a failed call (JSON error body)", async () => {
    await call("vault_append", { path: "a.md", content: "x" });
    expect(recorded).toEqual([]);
  });

  it("counts a note for a created vault note, not for a profile edit", async () => {
    expect(await call("vault_write", { path: "a.md", content: "x" })).toMatchObject({
      note: true,
    });
    expect(await call("my_context_update", { content: "x" })).toMatchObject({ note: false });
  });
});
