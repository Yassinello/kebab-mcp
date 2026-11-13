/**
 * TRU-04 — /approve/<id> is admin-gated by proxy.ts like /config, and a
 * cross-site arrival without the (SameSite=Strict) admin cookie gets one
 * same-origin hop before the sign-in page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const savedEnv = { ...process.env };
const PATH = `/approve/${"a".repeat(32)}?sig=${"b".repeat(64)}`;

function makeReq(
  url: string,
  opts: { headers?: Record<string, string>; cookie?: string } = {}
): NextRequest {
  const headers = new Headers(opts.headers ?? {});
  if (opts.cookie) headers.set("cookie", `kebab_admin_token=${opts.cookie}`);
  const u = new URL(url);
  return {
    method: "GET",
    nextUrl: u,
    url: u.toString(),
    headers,
    cookies: {
      get: (name: string) =>
        name === "kebab_admin_token" && opts.cookie ? { name, value: opts.cookie } : undefined,
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock("@/core/first-run-edge", () => ({
    ensureBootstrapRehydratedFromUpstash: vi.fn(async () => undefined),
    getEdgeBootstrapAuthToken: (): string | null => null,
  }));
  for (const k of ["MCP_AUTH_TOKEN", "ADMIN_AUTH_TOKEN", "INSTANCE_MODE", "VERCEL", "NODE_ENV"]) {
    delete process.env[k];
  }
  process.env.ADMIN_AUTH_TOKEN = "admin-token";
});

afterEach(() => {
  vi.doUnmock("@/core/first-run-edge");
  process.env = { ...savedEnv };
});

describe("proxy — /approve/<id>", () => {
  it("without admin auth renders the sign-in page (401)", async () => {
    const { proxy } = await import("@/../proxy");
    const res = await proxy(makeReq(`https://example.test${PATH}`));
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("Admin token");
    // The GET sign-in form keeps the link's signature (a GET form would
    // otherwise replace the query string with its own fields).
    expect(html).toContain(`action="/approve/${"a".repeat(32)}"`);
    expect(html).toContain(`<input type="hidden" name="sig" value="${"b".repeat(64)}">`);
  });

  it("with the admin cookie passes through", async () => {
    const { proxy } = await import("@/../proxy");
    const res = await proxy(makeReq(`https://example.test${PATH}`, { cookie: "admin-token" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("cross-site arrival without cookie → same-origin meta-refresh hop (no token leak)", async () => {
    const { proxy } = await import("@/../proxy");
    const res = await proxy(
      makeReq(`https://example.test${PATH}`, { headers: { "sec-fetch-site": "cross-site" } })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain(PATH.replace(/&/g, "&amp;"));
    expect(html).not.toContain("admin-token");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("the hop happens once: a same-origin miss gets the sign-in page", async () => {
    const { proxy } = await import("@/../proxy");
    const res = await proxy(
      makeReq(`https://example.test${PATH}`, { headers: { "sec-fetch-site": "same-origin" } })
    );
    expect(res.status).toBe(401);
  });

  it("/config keeps its previous behaviour on cross-site arrivals", async () => {
    const { proxy } = await import("@/../proxy");
    const res = await proxy(
      makeReq("https://example.test/config", { headers: { "sec-fetch-site": "cross-site" } })
    );
    expect(res.status).toBe(401);
  });
});
