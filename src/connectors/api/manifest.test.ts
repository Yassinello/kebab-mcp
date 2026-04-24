import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createApiConnection,
  createApiTool,
  updateApiTool,
  deleteApiTool,
  deleteApiToolsForConnection,
  _resetApiToolsCacheForTests,
} from "./store";
import { apiConnectionsConnector } from "./manifest";
import { resetKVStoreCache } from "@/core/kv-store";

/**
 * Regression coverage for the v0.15 "custom tools return 0 on cold lambda"
 * bug. See skills/manifest.test.ts for the same pattern.
 */

describe("api-connections connector refresh hook", () => {
  let tmp: string;
  const origKv = process.env.MYMCP_KV_PATH;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-api-manifest-"));
    process.env.MYMCP_KV_PATH = path.join(tmp, "kv.json");
    resetKVStoreCache();
    _resetApiToolsCacheForTests();
  });

  afterEach(async () => {
    if (origKv === undefined) delete process.env.MYMCP_KV_PATH;
    else process.env.MYMCP_KV_PATH = origKv;
    resetKVStoreCache();
    _resetApiToolsCacheForTests();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("declares a refresh hook", () => {
    expect(typeof apiConnectionsConnector.refresh).toBe("function");
  });

  it("exposes custom tools after refresh() primes the cache", async () => {
    const conn = await createApiConnection({
      name: "Acme",
      baseUrl: "https://api.acme.example.com",
      auth: { type: "none" },
    });
    await createApiTool({
      connectionId: conn.id,
      name: "ping",
      method: "GET",
      pathTemplate: "/ping",
    });

    // Drop the cache to simulate a fresh cold lambda.
    _resetApiToolsCacheForTests();
    expect(apiConnectionsConnector.tools).toHaveLength(0);

    // Prime via the manifest hook.
    await apiConnectionsConnector.refresh?.();

    const after = apiConnectionsConnector.tools;
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe("ping");
  });

  it("createApiTool updates the sync cache in lock-step", async () => {
    await apiConnectionsConnector.refresh?.();
    expect(apiConnectionsConnector.tools).toHaveLength(0);

    const conn = await createApiConnection({
      name: "Acme",
      baseUrl: "https://api.acme.example.com",
      auth: { type: "none" },
    });
    await createApiTool({
      connectionId: conn.id,
      name: "live_tool",
      method: "GET",
      pathTemplate: "/x",
    });

    // No explicit refresh required — the write path populated the cache.
    expect(apiConnectionsConnector.tools).toHaveLength(1);
  });
});

/**
 * Lock-step contract: every write-path in api/store.ts that mutates tools
 * must also assign _syncCache immediately so apiConnectionsConnector.tools
 * (synchronous) reflects the new state without another refresh() call.
 *
 * Verification method: comment out `_syncCache = all` in any of the write
 * paths in store.ts → the corresponding test below must turn red.
 */
describe("api-connections store: write paths must keep _syncCache in lock-step", () => {
  let tmp: string;
  const origKv = process.env.MYMCP_KV_PATH;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-api-lockstep-"));
    process.env.MYMCP_KV_PATH = path.join(tmp, "kv.json");
    resetKVStoreCache();
    _resetApiToolsCacheForTests();
    await apiConnectionsConnector.refresh?.();
  });

  afterEach(async () => {
    if (origKv === undefined) delete process.env.MYMCP_KV_PATH;
    else process.env.MYMCP_KV_PATH = origKv;
    resetKVStoreCache();
    _resetApiToolsCacheForTests();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("updateApiTool reflects in tools without refresh", async () => {
    const conn = await createApiConnection({
      name: "Acme",
      baseUrl: "https://api.acme.example.com",
      auth: { type: "none" },
    });
    const tool = await createApiTool({
      connectionId: conn.id,
      name: "get_item",
      method: "GET",
      pathTemplate: "/items/{{id}}",
    });
    expect(apiConnectionsConnector.tools).toHaveLength(1);

    await updateApiTool(tool.id, { pathTemplate: "/items/{{id}}/v2" });

    // No refresh — _syncCache must be current.
    expect(apiConnectionsConnector.tools).toHaveLength(1);
    expect(apiConnectionsConnector.tools[0]?.name).toBe("get_item");
  });

  it("deleteApiTool reflects in tools without refresh", async () => {
    const conn = await createApiConnection({
      name: "Acme",
      baseUrl: "https://api.acme.example.com",
      auth: { type: "none" },
    });
    const tool = await createApiTool({
      connectionId: conn.id,
      name: "del_me",
      method: "DELETE",
      pathTemplate: "/items/{{id}}",
    });
    expect(apiConnectionsConnector.tools).toHaveLength(1);

    await deleteApiTool(tool.id);

    expect(apiConnectionsConnector.tools).toHaveLength(0);
  });

  it("deleteApiToolsForConnection cascades to tools without refresh", async () => {
    const conn = await createApiConnection({
      name: "Acme",
      baseUrl: "https://api.acme.example.com",
      auth: { type: "none" },
    });
    await createApiTool({
      connectionId: conn.id,
      name: "tool_a",
      method: "GET",
      pathTemplate: "/a",
    });
    await createApiTool({
      connectionId: conn.id,
      name: "tool_b",
      method: "GET",
      pathTemplate: "/b",
    });
    expect(apiConnectionsConnector.tools).toHaveLength(2);

    const removed = await deleteApiToolsForConnection(conn.id);
    expect(removed).toBe(2);
    expect(apiConnectionsConnector.tools).toHaveLength(0);
  });

  it("createApiConnection alone does not touch _syncCache (tools stays 0)", async () => {
    // After refresh(), tools = 0. Creating a connection (no tools) must not
    // accidentally push into _syncCache.
    expect(apiConnectionsConnector.tools).toHaveLength(0);

    await createApiConnection({
      name: "Solo",
      baseUrl: "https://api.solo.example.com",
      auth: { type: "none" },
    });

    expect(apiConnectionsConnector.tools).toHaveLength(0);
  });
});
