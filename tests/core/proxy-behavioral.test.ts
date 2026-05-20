/**
 * Phase 50 / COV-03 — proxy.ts middleware behavioral test.
 *
 * Replaces the Phase 40 grep-contract coverage of proxy.ts (TEST-04)
 * with a true behavioral test that exercises the three documented
 * branches in the middleware:
 *
 *   1. Rehydrate path — first cold-lambda request with no MCP_AUTH_TOKEN
 *      in process.env. Middleware calls ensureBootstrapRehydratedFromUpstash,
 *      which populates process.env from KV if present.
 *   2. KV-alias path — admin-gated request with a cookie matching the
 *      rehydrated admin token. Middleware authorizes and lets the
 *      request through.
 *   3. Early-return path — request carries a ?token= query param that
 *      matches; middleware returns a redirect + Set-Cookie without
 *      touching KV.
 *
 * Negative coverage: unauthorized request on /config returns 401.
 *
 * Uses vi.mock at the module boundary so we directly control what the
 * rehydrate helper + request.cookies see. No HTTP server startup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";

type RehydrateMock = ReturnType<typeof vi.fn>;

describe("Phase 50 / COV-03 — proxy.ts middleware behavioral coverage", () => {
  const savedEnv = { ...process.env };
  let rehydrateMock: RehydrateMock;

  beforeEach(async () => {
    // Reset module graph so the vi.mock() below takes effect on
    // proxy's ensureBootstrapRehydratedFromUpstash import.
    vi.resetModules();
    rehydrateMock = vi.fn(async () => undefined);
    vi.doMock("@/core/first-run-edge", () => ({
      ensureBootstrapRehydratedFromUpstash: rehydrateMock,
      getEdgeBootstrapAuthToken: (): string | null => null,
    }));

    // Clean process.env for each test — each test sets its own shape.
    for (const k of [
      "MCP_AUTH_TOKEN",
      "ADMIN_AUTH_TOKEN",
      "INSTANCE_MODE",
      "VERCEL",
      "NODE_ENV",
      "UPSTASH_REDIS_REST_URL",
    ]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    vi.doUnmock("@/core/first-run-edge");
    process.env = { ...savedEnv };
  });

  function makeReq(
    url: string,
    opts: { headers?: Record<string, string>; cookies?: Record<string, string> } = {}
  ): NextRequest {
    const headers = new Headers(opts.headers ?? {});
    if (opts.cookies) {
      const cookieHeader = Object.entries(opts.cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("; ");
      headers.set("cookie", cookieHeader);
    }
    // Mimic NextRequest shape enough for proxy.ts to read nextUrl,
    // headers, cookies.
    const u = new URL(url);
    return {
      nextUrl: u,
      url: u.toString(),
      headers,
      cookies: {
        get: (name: string) => {
          const match = (headers.get("cookie") || "").match(
            new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)
          );
          return match?.[1] ? { name, value: decodeURIComponent(match[1]) } : undefined;
        },
      },
    } as unknown as NextRequest;
  }

  it("rehydrate branch — every request hits ensureBootstrapRehydratedFromUpstash exactly once", async () => {
    process.env.MCP_AUTH_TOKEN = "admin-token";
    const { proxy } = await import("@/../proxy");

    const req = makeReq("https://example.test/config", {
      cookies: { kebab_admin_token: "admin-token" },
    });
    await proxy(req);

    expect(rehydrateMock).toHaveBeenCalledTimes(1);
  });

  it("kv-alias / cookie-auth branch — admin cookie allows /config access", async () => {
    process.env.MCP_AUTH_TOKEN = "admin-token";
    const { proxy } = await import("@/../proxy");

    const req = makeReq("https://example.test/config", {
      cookies: { kebab_admin_token: "admin-token" },
    });
    const res = await proxy(req);

    // Authorized → passthrough (status unset → 200 chain). The response
    // carries the CSP + x-request-id headers (finalize()).
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/default-src 'self'/);
  });

  it("early-return branch — ?token= query param sets cookie + redirects (token stripped)", async () => {
    process.env.MCP_AUTH_TOKEN = "admin-token";
    const { proxy } = await import("@/../proxy");

    const req = makeReq("https://example.test/config?token=admin-token");
    const res = await proxy(req);

    // 307/308 redirect with token-stripped location.
    expect([307, 308]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toMatch(/\/config/);
    expect(loc).not.toMatch(/token=/);

    // Set-Cookie emits BOTH modern + legacy (Phase 50 / BRAND-02).
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("kebab_admin_token=admin-token"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("mymcp_admin_token=admin-token"))).toBe(true);
  });

  it("unauthorized branch — /config with no token returns 401", async () => {
    process.env.MCP_AUTH_TOKEN = "admin-token";
    const { proxy } = await import("@/../proxy");

    const req = makeReq("https://example.test/config");
    const res = await proxy(req);

    expect(res.status).toBe(401);
    // Sanitized body — no token leak.
    const body = await res.text();
    expect(body).not.toContain("admin-token");
  });

  it("legacy cookie (mymcp_admin_token) still accepted during BRAND-02 transition", async () => {
    process.env.MCP_AUTH_TOKEN = "admin-token";
    const { proxy } = await import("@/../proxy");

    const req = makeReq("https://example.test/config", {
      cookies: { mymcp_admin_token: "admin-token" },
    });
    const res = await proxy(req);

    expect(res.status).toBe(200);
  });

  it("HIGH-3 — multi-token list authorizes a device holding any one token", async () => {
    // Comma-separated multi-device deploy. A device that holds only the
    // SECOND token must still get into /config — the pre-fix middleware
    // compared against the whole raw "tok1,tok2" string and denied it.
    process.env.MCP_AUTH_TOKEN = "device-a-token, device-b-token";
    const { proxy } = await import("@/../proxy");

    const reqB = makeReq("https://example.test/config", {
      cookies: { kebab_admin_token: "device-b-token" },
    });
    expect((await proxy(reqB)).status).toBe(200);

    const reqA = makeReq("https://example.test/config", {
      cookies: { kebab_admin_token: "device-a-token" },
    });
    expect((await proxy(reqA)).status).toBe(200);

    // A token NOT in the list is still rejected.
    const reqBad = makeReq("https://example.test/config", {
      cookies: { kebab_admin_token: "device-c-token" },
    });
    expect((await proxy(reqBad)).status).toBe(401);
  });

  it("first-time setup — missing MCP_AUTH_TOKEN redirects /config → /welcome", async () => {
    // No MCP_AUTH_TOKEN and no INSTANCE_MODE — first-run path.
    const { proxy } = await import("@/../proxy");

    const req = makeReq("https://example.test/config");
    const res = await proxy(req);

    expect([307, 308]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toMatch(/\/welcome/);
  });

  it("showcase mode — /welcome redirects to / (public template deploys)", async () => {
    process.env.INSTANCE_MODE = "showcase";
    const { proxy } = await import("@/../proxy");

    const req = makeReq("https://example.test/welcome");
    const res = await proxy(req);

    expect([307, 308]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toMatch(/https:\/\/example\.test\/?$/);
  });
});
