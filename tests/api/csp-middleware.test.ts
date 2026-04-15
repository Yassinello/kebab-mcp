/**
 * Middleware CSP tests.
 *
 * The CSP header is now set by `proxy.ts` (Next 16 middleware file name)
 * rather than `next.config.ts`, so we exercise it by calling the proxy
 * function directly with a NextRequest. No dev server, no fetch.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../proxy";

function nextReq(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new Request(`http://mymcp.local${path}`, { headers }));
}

describe("proxy.ts CSP middleware", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Give the proxy a valid MCP token so requests don't fall into the
    // first-run redirect branch (which would 302 and still set CSP, but
    // /api/config/logs would hit the auth path).
    process.env.MCP_AUTH_TOKEN = "middleware-test-token-1234567890";
    (process.env as Record<string, string>).NODE_ENV = "production";
    delete process.env.UPSTASH_REDIS_REST_URL;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("sets Content-Security-Policy on a passthrough response", () => {
    const res = proxy(nextReq("/"));
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("nonce-");
    expect(csp).toContain("default-src 'self'");
  });

  it("does not include 'unsafe-inline' in script-src when NODE_ENV=production", () => {
    const res = proxy(nextReq("/"));
    const csp = res.headers.get("Content-Security-Policy")!;
    // Extract script-src directive.
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc!).not.toContain("'unsafe-inline'");
    expect(scriptSrc!).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });

  it("includes 'unsafe-inline' in script-src in development (HMR needs it)", () => {
    (process.env as Record<string, string>).NODE_ENV = "development";
    const res = proxy(nextReq("/"));
    const csp = res.headers.get("Content-Security-Policy")!;
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))!;
    expect(scriptSrc).toContain("'unsafe-inline'");
  });

  it("mints a fresh nonce per request", () => {
    const a = proxy(nextReq("/")).headers.get("Content-Security-Policy")!;
    const b = proxy(nextReq("/")).headers.get("Content-Security-Policy")!;
    const extract = (csp: string) => csp.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1] ?? "";
    expect(extract(a)).toBeTruthy();
    expect(extract(b)).toBeTruthy();
    expect(extract(a)).not.toBe(extract(b));
  });

  it("sets CSP even on the 401 unauthorized branch for admin routes", () => {
    const res = proxy(nextReq("/config"));
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Security-Policy")).toContain("nonce-");
  });
});
