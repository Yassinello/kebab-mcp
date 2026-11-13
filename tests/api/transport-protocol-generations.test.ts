/**
 * PRO-02 — both MCP protocol generations served by the REAL transport.
 *
 * No mcp-handler / SDK mock: the actual `app/api/[transport]/route.ts`
 * pipeline (auth, rate limit, credentials, token scope, logging, usage
 * counters) builds a real `@modelcontextprotocol/server` McpServer through
 * `mcp-handler` 2.x and answers real JSON-RPC over HTTP:
 *
 *  (a) a 2025-era client: `initialize` (2025-06-18) → `tools/list` →
 *      `tools/call`, each a stateless Streamable HTTP POST;
 *  (b) a 2026-07-28 client: `server/discover` → `tools/list` → `tools/call`,
 *      each request carrying the per-request `_meta` envelope
 *      (`io.modelcontextprotocol/protocolVersion` + `clientCapabilities`)
 *      and the SEP-2243 standard headers (`MCP-Protocol-Version`,
 *      `Mcp-Method`, and `Mcp-Name` for `tools/call` / `prompts/get` /
 *      `resources/read`).
 *
 * Only the connector registry is replaced, by one deterministic test pack
 * (a read-only tool, a destructive tool, a tool with an outputSchema, a
 * prompt, a resource provider and an instructions contribution) so the
 * assertions don't depend on which connectors the environment enables.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN = "proto-gen-test-token";
const MCP_URL = "https://kebab.test/api/mcp";

async function buildTestPack() {
  const { z: zod } = await import("zod");
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const testPack = {
    id: "protogen",
    label: "Protocol generations test pack",
    description: "test",
    requiredEnvVars: [] as string[],
    tools: [
      {
        name: "echo_text",
        description: "Echo the given text back.",
        schema: { text: zod.string().describe("Text to echo") },
        handler: async (args: Record<string, unknown>) => text(`echo: ${String(args.text)}`),
        destructive: false,
      },
      {
        name: "note_delete",
        title: "Delete a note",
        description: "Pretend to delete a note.",
        schema: { id: zod.string() },
        handler: async (args: Record<string, unknown>) => text(`deleted ${String(args.id)}`),
        destructive: true,
        openWorld: false,
      },
      {
        name: "structured_answer",
        description: "Return structured content.",
        schema: {},
        outputSchema: { type: "object", properties: { answer: { type: "number" } } },
        handler: async () => ({
          ...text('{"answer":42}'),
          structuredContent: { answer: 42 },
        }),
        destructive: false,
      },
    ],
    instructions: () => "Protocol generations test instructions.",
    resources: {
      scheme: "proto",
      list: async () => [{ uri: "proto://hello", name: "hello", mimeType: "text/plain" }],
      read: async (uri: string) => ({ uri, mimeType: "text/plain", text: `body of ${uri}` }),
    },
    registerPrompts: (server: unknown) => {
      (
        server as {
          registerPrompt: (
            name: string,
            config: { description: string; argsSchema: unknown },
            cb: (args: { who?: string }) => unknown
          ) => void;
        }
      ).registerPrompt(
        "greet",
        { description: "Greet someone", argsSchema: zod.object({ who: zod.string() }) },
        async ({ who }) => ({
          messages: [{ role: "user", content: { type: "text", text: `Hello ${who}` } }],
        })
      );
    },
  };
  return testPack;
}

vi.mock("@/core/registry", async () => {
  const testPack = await buildTestPack();
  const packs = [{ manifest: testPack, enabled: true, reason: "active" }];
  return {
    getEnabledPacksLazy: async () => packs,
    logRegistryState: async () => undefined,
    resolveRegistryAsync: async () => packs,
    isCoreConnector: (id: string) => ["skills", "admin", "context"].includes(id),
    ALL_CONNECTOR_LOADERS: [],
  };
});

type JsonRpc = {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

let POST: (req: Request) => Promise<Response>;
let GET: (req: Request) => Promise<Response>;
let tmp: string;

/** Parse a JSON or single-event SSE response body into the JSON-RPC message. */
async function readRpc(res: Response): Promise<JsonRpc> {
  const body = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const data = body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return JSON.parse(data[data.length - 1]!) as JsonRpc;
  }
  return JSON.parse(body) as JsonRpc;
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

// ── 2025-era client ────────────────────────────────────────────────────
const LEGACY_VERSION = "2025-06-18";
function legacy(id: number, method: string, params: Record<string, unknown> = {}) {
  return post(
    { jsonrpc: "2.0", id, method, params },
    method === "initialize" ? {} : { "mcp-protocol-version": LEGACY_VERSION }
  );
}

// ── 2026-07-28 client ──────────────────────────────────────────────────
const MODERN_VERSION = "2026-07-28";
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "proto-gen-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
function modern(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  name?: string
): Promise<Response> {
  return post(
    { jsonrpc: "2.0", id, method, params: { ...params, _meta: ENVELOPE } },
    {
      "mcp-protocol-version": MODERN_VERSION,
      "mcp-method": method,
      ...(name !== undefined ? { "mcp-name": name } : {}),
    }
  );
}

type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

function expectAnnotatedTools(tools: ListedTool[]): void {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  expect(Object.keys(byName).sort()).toEqual(["echo_text", "note_delete", "structured_answer"]);
  for (const t of tools) {
    expect(t.title, t.name).toBeTruthy();
    expect(t.annotations, t.name).toMatchObject({
      title: t.title,
      readOnlyHint: expect.any(Boolean),
      destructiveHint: expect.any(Boolean),
      openWorldHint: expect.any(Boolean),
    });
  }
  expect(byName.echo_text!.title).toBe("Echo text");
  expect(byName.echo_text!.annotations).toEqual({
    title: "Echo text",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  });
  expect(byName.note_delete!.annotations).toEqual({
    title: "Delete a note",
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
  // Schemas and descriptions are the manifest's, unchanged.
  expect(byName.echo_text!.description).toBe("Echo the given text back.");
  expect(byName.echo_text!.inputSchema).toMatchObject({
    type: "object",
    properties: { text: { type: "string", description: "Text to echo" } },
    required: ["text"],
  });
  expect(byName.structured_answer!.outputSchema).toMatchObject({ type: "object" });
  expect(byName.echo_text!.outputSchema).toBeUndefined();
}

// Set for the whole file (vitest's `unstubEnvs` would revert vi.stubEnv
// after the first test); restored in afterAll.
const ENV: Record<string, string> = {
  MCP_AUTH_TOKEN: TOKEN,
  MYMCP_RATE_LIMIT_ENABLED: "false",
};
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-protogen-"));
  ENV.MYMCP_KV_PATH = path.join(tmp, "kv.json");
  for (const [k, v] of Object.entries(ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  const { resetKVStoreCache } = await import("@/core/kv-store");
  resetKVStoreCache();
  const { __resetFirstRunForTests } = await import("@/core/first-run");
  __resetFirstRunForTests();
  const route = await import("../../app/api/[transport]/route");
  POST = route.POST as (req: Request) => Promise<Response>;
  GET = route.GET as (req: Request) => Promise<Response>;
}, 30_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fs.rm(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("PRO-02 — 2025-era client (initialize, stateless Streamable HTTP)", () => {
  it("initialize answers serverInfo, instructions and capabilities", async () => {
    const res = await legacy(1, "initialize", {
      protocolVersion: LEGACY_VERSION,
      capabilities: {},
      clientInfo: { name: "proto-gen-test", version: "1.0.0" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const msg = await readRpc(res);
    expect(msg.error).toBeUndefined();
    const result = msg.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      instructions?: string;
      capabilities: Record<string, unknown>;
    };
    expect(result.protocolVersion).toBe(LEGACY_VERSION);
    expect(result.serverInfo.name).toBe("Kebab House");
    expect(result.serverInfo.version).toBeTruthy();
    expect(result.instructions).toContain("Protocol generations test instructions.");
    expect(result.capabilities).toHaveProperty("tools");
    expect(result.capabilities).toHaveProperty("prompts");
    expect(result.capabilities).toHaveProperty("resources");
  });

  it("tools/list carries titles + TRU-01 annotations", async () => {
    const msg = await readRpc(await legacy(2, "tools/list"));
    expectAnnotatedTools((msg.result as { tools: ListedTool[] }).tools);
  });

  it("tools/call runs the tool (and structuredContent survives)", async () => {
    const msg = await readRpc(
      await legacy(3, "tools/call", { name: "echo_text", arguments: { text: "hi" } })
    );
    expect(msg.result).toMatchObject({ content: [{ type: "text", text: "echo: hi" }] });
    expect(msg.result?.isError).toBeFalsy();

    const structured = await readRpc(
      await legacy(4, "tools/call", { name: "structured_answer", arguments: {} })
    );
    expect(structured.result?.structuredContent).toEqual({ answer: 42 });
  });

  it("tools/call input validation still rejects bad arguments as a tool error", async () => {
    const msg = await readRpc(await legacy(5, "tools/call", { name: "echo_text", arguments: {} }));
    expect(msg.result?.isError).toBe(true);
    expect(JSON.stringify(msg.result)).toMatch(/Input validation error/);
  });

  it("prompts and resources keep working", async () => {
    const prompts = await readRpc(await legacy(6, "prompts/list"));
    expect((prompts.result as { prompts: { name: string }[] }).prompts.map((p) => p.name)).toEqual([
      "greet",
    ]);
    const prompt = await readRpc(
      await legacy(7, "prompts/get", { name: "greet", arguments: { who: "Ada" } })
    );
    expect(JSON.stringify(prompt.result)).toContain("Hello Ada");

    const resources = await readRpc(await legacy(8, "resources/list"));
    expect(resources.result).toMatchObject({ resources: [{ uri: "proto://hello" }] });
    const read = await readRpc(await legacy(9, "resources/read", { uri: "proto://hello" }));
    expect(read.result).toMatchObject({ contents: [{ text: "body of proto://hello" }] });
  });

  it("GET (2025 session stream) answers 405 — serving is stateless", async () => {
    const res = await GET(
      new Request(MCP_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
      })
    );
    expect(res.status).toBe(405);
  });
});

describe("PRO-02 — 2026-07-28 client (server/discover, per-request envelope)", () => {
  it("server/discover answers supported versions, capabilities, instructions and serverInfo", async () => {
    const res = await modern(1, "server/discover");
    expect(res.status).toBe(200);
    const msg = await readRpc(res);
    expect(msg.error).toBeUndefined();
    const result = msg.result as {
      supportedVersions: string[];
      capabilities: Record<string, unknown>;
      instructions?: string;
      _meta?: Record<string, { name: string }>;
    };
    expect(result.supportedVersions).toContain(MODERN_VERSION);
    expect(result.capabilities).toHaveProperty("tools");
    expect(result.capabilities).toHaveProperty("resources");
    expect(result.instructions).toContain("Protocol generations test instructions.");
    expect(result._meta?.["io.modelcontextprotocol/serverInfo"]?.name).toBe("Kebab House");
  });

  it("tools/list carries titles + TRU-01 annotations", async () => {
    const msg = await readRpc(await modern(2, "tools/list"));
    expect(msg.error).toBeUndefined();
    expectAnnotatedTools((msg.result as { tools: ListedTool[] }).tools);
  });

  it("tools/call runs the tool (and structuredContent survives)", async () => {
    const msg = await readRpc(
      await modern(3, "tools/call", { name: "echo_text", arguments: { text: "hi" } }, "echo_text")
    );
    expect(msg.error).toBeUndefined();
    expect(msg.result).toMatchObject({ content: [{ type: "text", text: "echo: hi" }] });

    const structured = await readRpc(
      await modern(
        4,
        "tools/call",
        { name: "structured_answer", arguments: {} },
        "structured_answer"
      )
    );
    expect(structured.result?.structuredContent).toEqual({ answer: 42 });
  });

  it("prompts and resources keep working", async () => {
    const prompt = await readRpc(
      await modern(5, "prompts/get", { name: "greet", arguments: { who: "Ada" } }, "greet")
    );
    expect(prompt.error).toBeUndefined();
    expect(JSON.stringify(prompt.result)).toContain("Hello Ada");

    const read = await readRpc(
      await modern(6, "resources/read", { uri: "proto://hello" }, "proto://hello")
    );
    expect(read.error).toBeUndefined();
    expect(read.result).toMatchObject({ contents: [{ text: "body of proto://hello" }] });
  });
});

describe("PRO-02 — only /api/mcp is served", () => {
  it.each(["sse", "message", "foo"])("/api/%s answers 404 Not found", async (segment) => {
    const res = await POST(
      new Request(`https://kebab.test/api/${segment}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("an unauthenticated request is still refused before the path check", async () => {
    const res = await POST(new Request("https://kebab.test/api/sse", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("the Next route params win over the URL when present", async () => {
    const res = await (
      POST as (req: Request, ctx: { params: Promise<{ transport: string }> }) => Promise<Response>
    )(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      { params: Promise.resolve({ transport: "sse" }) }
    );
    expect(res.status).toBe(404);
  });
});
