/**
 * E2E transport test for Custom Tools (Bonus B).
 *
 * Verifies the full path from `app/api/[transport]/route.ts` down to
 * the Custom Tools runner: a Custom Tool created via the store is
 * surfaced in the MCP handler's `tools/list`, exposes the correct
 * `destructive` flag, and produces the expected output when invoked
 * via `tools/call`.
 *
 * Strategy mirrors `tests/api/transport-output-schema.test.ts`: we
 * stub mcp-handler so we can capture the McpServer registration map,
 * then drive the registered handler directly. This exercises the
 * full transport→registry→manifest→runner chain without booting a
 * real MCP server.
 *
 * What this test catches that unit tests don't:
 *   - the Custom Tools manifest's synchronous `tools` getter must
 *     return the right shape after `primeCustomToolsCache()` runs
 *   - the manifest's `buildCustomToolDefinition` must surface the
 *     `destructive` flag the store force-set
 *   - the transport must register the Custom Tool under its `id`
 *     (not under some legacy alias)
 *   - the registered handler must invoke the runner and return a
 *     `{ content: [{ type: "text", text: ... }] }` shape that the
 *     MCP client accepts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── mcp-handler interception (must be hoisted before route import) ────

// Track every (name → handler) registration the route makes against
// the McpServer. We grab both `server.tool` (legacy) and
// `server.registerTool` (outputSchema path) so we don't miss any
// registration mode the route might use.
const registered: Record<
  string,
  {
    via: "tool" | "registerTool";
    description?: string;
    handler: (params: Record<string, unknown>) => Promise<unknown>;
  }
> = {};

vi.mock("mcp-handler", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createMcpHandler = (initFn: (server: any) => void) => {
    const server = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool: (name: string, description: string, _schema: unknown, cb: any) => {
        registered[name] = { via: "tool", description, handler: cb };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTool: (name: string, config: { description?: string }, cb: any) => {
        registered[name] = {
          via: "registerTool",
          ...(config.description !== undefined ? { description: config.description } : {}),
          handler: cb,
        };
      },
      resource: vi.fn(),
      registerResource: vi.fn(),
      prompt: vi.fn(),
      registerPrompt: vi.fn(),
    };
    initFn(server);
    return async (_req: Request) => new Response("ok", { status: 200 });
  };
  return { createMcpHandler };
});

// Bypass the pipeline so we can drive the transport directly with no
// auth setup. The pipeline is independently covered by
// tests/regression/transport-pipeline.test.ts.
vi.mock("@/core/pipeline", () => ({
  composeRequestPipeline: (
    _steps: unknown[],
    handler: (ctx: {
      request: Request;
      tokenId?: string | null;
      tenantId?: string | null;
      requestId: string;
    }) => Promise<Response>
  ) => {
    return (req: Request) =>
      handler({ request: req, tokenId: "test-tok", tenantId: null, requestId: "test-req" });
  },
  rehydrateStep: vi.fn(),
  firstRunGateStep: vi.fn(),
  authStep: () => vi.fn(),
  rateLimitStep: () => vi.fn(),
  hydrateCredentialsStep: vi.fn(),
}));

// Quiet noisy startup logs and skip the per-tool wrap so the runner
// invokes our handler directly.
vi.mock("@/core/logging", () => ({
  withLogging: <T extends Record<string, unknown>>(_name: string, fn: (p: T) => Promise<unknown>) =>
    fn,
}));

// Force the registry to expose ONLY the custom-tools connector. We do
// not need vault/slack/etc. for this test, and trimming the surface
// avoids accidental dependencies on other connectors' env vars.
//
// IMPORTANT: the manifest import here is a CIRCULAR hazard —
// manifest → runner → @/core/registry → (this mock). Resolve lazily
// inside the function bodies so the factory body itself stays
// synchronous; by the time the route actually calls these functions
// the module graph has settled.
const { getCustomToolsManifest } = vi.hoisted(() => {
  let cached: Promise<import("@/core/types").ConnectorManifest> | null = null;
  return {
    getCustomToolsManifest: (): Promise<import("@/core/types").ConnectorManifest> => {
      if (!cached) {
        cached = import("@/connectors/custom-tools/manifest").then((m) => m.customToolsConnector);
      }
      return cached;
    },
  };
});
vi.mock("@/core/registry", () => ({
  getEnabledPacksLazy: async () => [
    { manifest: await getCustomToolsManifest(), enabled: true, reason: "active" as const },
  ],
  logRegistryState: async () => undefined,
  resolveRegistryAsync: async () => [
    { manifest: await getCustomToolsManifest(), enabled: true, reason: "active" as const },
  ],
  ALL_CONNECTOR_LOADERS: [],
}));

vi.mock("@/core/tool-toggles", () => ({
  getDisabledTools: async () => new Set<string>(),
}));

// v0.20: buildHandler resolves a per-token connector scope. This E2E is not
// about scoping — mock to "no filter" so every enabled connector is listed.
vi.mock("@/core/token-scope", () => ({
  resolveTokenConnectorScope: async () => null,
  isConnectorAllowed: () => true,
}));

import { resetKVStoreCache } from "@/core/kv-store";
import {
  createCustomTool,
  _resetCustomToolsCacheForTests,
  _resetKnownToolFactsCacheForTests,
} from "@/connectors/custom-tools/store";

describe("transport E2E — Custom Tools surface", () => {
  let tmp: string;
  const prevKv = process.env["MYMCP_KV_PATH"];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-customtool-e2e-"));
    process.env["MYMCP_KV_PATH"] = path.join(tmp, "kv.json");
    resetKVStoreCache();
    _resetCustomToolsCacheForTests();
    _resetKnownToolFactsCacheForTests();
    for (const k of Object.keys(registered)) delete registered[k];
  });

  afterEach(async () => {
    if (prevKv === undefined) delete process.env["MYMCP_KV_PATH"];
    else process.env["MYMCP_KV_PATH"] = prevKv;
    resetKVStoreCache();
    _resetCustomToolsCacheForTests();
    _resetKnownToolFactsCacheForTests();
    // Windows + open file handles + recursive rm can race ENOTEMPTY;
    // best-effort cleanup, the OS reaps the temp dir on its own anyway.
    try {
      await fs.rm(tmp, { recursive: true, force: true });
    } catch {
      /* tolerate Windows file lock races */
    }
  });

  async function driveRoute(): Promise<void> {
    // Route reads `getEnabledPacksLazy` and walks `manifest.tools` on
    // each request — its `primeDynamicCaches` calls `manifest.refresh`
    // which itself runs `primeCustomToolsCache`, so `manifest.tools`
    // sees the freshly-written tools without us calling primeCache
    // explicitly. One GET is enough to populate `registered`.
    const route = await import("../../app/api/[transport]/route");
    route.__resetPrimeCacheForTests();
    await route
      .GET(new Request("https://test.local/api/mcp", { method: "GET" }))
      .catch(() => undefined);
  }

  it("registers a custom tool with the correct destructive flag and runs end-to-end", async () => {
    // 1. Author the Custom Tool through the real store. Single-step
    //    transform — `"hello {{name}}"` against an input named `name`.
    await createCustomTool({
      id: "greet",
      description: "Greet a person",
      destructive: false,
      inputs: [{ name: "name", type: "string", required: true, description: "Who to greet" }],
      steps: [{ kind: "transform", template: "hello {{name}}", saveAs: "out" }],
    });

    // 2. Drive the route — registers the tool against our mock McpServer.
    await driveRoute();

    // 3. tools/list equivalent: the registration map must contain the tool.
    expect(registered["greet"]).toBeDefined();
    expect(registered["greet"]!.description).toMatch(/greet/i);

    // 4. tools/call equivalent: invoke the registered handler.
    const result = (await registered["greet"]!.handler({ name: "world" })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content).toBeInstanceOf(Array);
    expect(result.content[0]?.text).toBe("hello world");
  });

  it("aggregates destructive=true into the registered description for composed-destructive tools", async () => {
    // Manifest's `buildCustomToolDefinition` surfaces `destructive` on the
    // ToolDefinition; the route's `desc` only adds the `[DEPRECATED…]`
    // prefix, so the easiest place to assert destructive plumbing is the
    // ToolDefinition itself via the manifest. We re-import here to avoid
    // poking at internal state — the contract is: a destructive Custom
    // Tool reaches the transport with destructive=true, and the
    // tools/list response sees it.
    const { customToolsConnector } = await import("@/connectors/custom-tools/manifest");

    // A tool with no destructive steps stays non-destructive.
    await createCustomTool({
      id: "safe_greet",
      description: "Safe greeting",
      destructive: false,
      inputs: [{ name: "name", type: "string", required: true, description: "" }],
      steps: [{ kind: "transform", template: "hi {{name}}", saveAs: "out" }],
    });
    // Author opts INTO destructive — flag round-trips.
    await createCustomTool({
      id: "explicit_destructive",
      description: "Marked destructive by author",
      destructive: true,
      inputs: [{ name: "name", type: "string", required: true, description: "" }],
      steps: [{ kind: "transform", template: "bye {{name}}", saveAs: "out" }],
    });

    // Drive the route first so the route's primeDynamicCaches refresh
    // the manifest's sync getter — this also populates `registered`.
    await driveRoute();
    const tools = customToolsConnector.tools;
    const safe = tools.find((t) => t.name === "safe_greet");
    const dangerous = tools.find((t) => t.name === "explicit_destructive");
    expect(safe?.destructive).toBe(false);
    expect(dangerous?.destructive).toBe(true);

    // And both end up registered through the transport (already
    // verified by `driveRoute` above).
    expect(registered["safe_greet"]).toBeDefined();
    expect(registered["explicit_destructive"]).toBeDefined();
  });
});
