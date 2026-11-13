/**
 * TRU-01 — every tool listed by the REAL transport (real registry, real
 * mcp-handler / SDK v2) carries a title and the four MCP annotations
 * derived from its manifest. Complements the deterministic test pack in
 * transport-protocol-generations.test.ts with whatever connectors the
 * registry enables here (at least the core ones: context, skills, admin).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolAnnotations } from "@/core/tool-annotations";

const TOKEN = "annotations-test-token";
const ENV: Record<string, string> = { MCP_AUTH_TOKEN: TOKEN, MYMCP_RATE_LIMIT_ENABLED: "false" };
const savedEnv: Record<string, string | undefined> = {};
let tmp: string;

type ListedTool = { name: string; title?: string; annotations?: Record<string, unknown> };

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-annotations-"));
  ENV.MYMCP_KV_PATH = path.join(tmp, "kv.json");
  for (const [k, v] of Object.entries(ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  const { resetKVStoreCache } = await import("@/core/kv-store");
  resetKVStoreCache();
  const { __resetFirstRunForTests } = await import("@/core/first-run");
  __resetFirstRunForTests();
});

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

describe("TRU-01 — tools/list annotations (real registry)", () => {
  it("every listed tool carries title + readOnly/destructive/openWorld hints from its manifest", async () => {
    const route = await import("../../app/api/[transport]/route");
    const res = await (route.POST as (req: Request) => Promise<Response>)(
      new Request("https://kebab.test/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
    );
    expect(res.status).toBe(200);
    // 2025-era stateless serving answers over a one-event SSE stream.
    const body = await res.text();
    const data = body.split("\n").find((l) => l.startsWith("data:")) ?? body;
    const msg = JSON.parse(data.replace(/^data:/, "")) as { result: { tools: ListedTool[] } };
    const listed = new Map(msg.result.tools.map((t) => [t.name, t]));

    const { getEnabledPacksLazy } = await import("@/core/registry");
    const packs = await getEnabledPacksLazy();
    let checked = 0;
    for (const pack of packs) {
      for (const tool of pack.manifest.tools) {
        const entry = listed.get(tool.name);
        expect(entry, `${tool.name} missing from tools/list`).toBeDefined();
        const expected = toolAnnotations(tool, pack.manifest);
        expect(entry!.title).toBe(expected.title);
        expect(entry!.annotations).toEqual(expected);
        checked++;
      }
    }
    // Core connectors are always on: my_context, skills_list, mcp_logs, …
    expect(checked).toBeGreaterThanOrEqual(5);
    expect(listed.get("my_context")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  }, 30_000);
});
