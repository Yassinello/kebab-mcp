/**
 * v0.6 / A3 — /api/setup/test dispatcher.
 *
 * The old giant switch on `body.pack` is gone. The route now looks up
 * the connector in the registry and calls `manifest.testConnection()`
 * wrapped in `withTimeout`. These tests verify the dispatch logic
 * without hitting real upstream APIs — we mock fetch() globally.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../../app/api/setup/test/route";

function makeReq(body: unknown): Request {
  return new Request("http://127.0.0.1/api/setup/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://127.0.0.1" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/setup/test (v0.6 dispatcher)", () => {
  const originalMcp = process.env.MCP_AUTH_TOKEN;

  beforeEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
  });
  afterEach(() => {
    if (originalMcp === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = originalMcp;
    vi.restoreAllMocks();
  });

  it("returns 403 once MCP_AUTH_TOKEN is set", async () => {
    process.env.MCP_AUTH_TOKEN = "sekret";
    const res = await POST(makeReq({ pack: "notion", credentials: {} }));
    expect(res.status).toBe(403);
  });

  it("returns 400 on missing pack", async () => {
    const res = await POST(makeReq({ credentials: {} }));
    expect(res.status).toBe(400);
  });

  it("returns generic 'no test available' for unknown pack", async () => {
    const res = await POST(makeReq({ pack: "nonexistent", credentials: {} }));
    const json = (await res.json()) as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toMatch(/no test available/i);
  });

  it("dispatches to notion connector testConnection()", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "MyBot", type: "bot" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const res = await POST(
      makeReq({ pack: "notion", credentials: { NOTION_API_KEY: "secret_x" } })
    );
    const json = (await res.json()) as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toMatch(/MyBot/);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.notion.com/v1/users/me",
      expect.objectContaining({ headers: expect.any(Object) })
    );
  });

  it("surfaces connector failure detail", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "unauthorized", message: "bad token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );
    const res = await POST(makeReq({ pack: "notion", credentials: { NOTION_API_KEY: "wrong" } }));
    const json = (await res.json()) as { ok: boolean; detail?: string };
    expect(json.ok).toBe(false);
    expect(json.detail).toMatch(/bad token|unauthorized/);
  });

  it("slack dispatch reuses credentials arg, not process.env", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, team: "Acme", user: "bot" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const res = await POST(
      makeReq({ pack: "slack", credentials: { SLACK_BOT_TOKEN: "xoxb-abc" } })
    );
    const json = (await res.json()) as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toMatch(/Acme/);
    const call = fetchSpy.mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-abc");
  });
});
