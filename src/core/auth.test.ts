import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseTokens, tokenId, checkMcpAuth, checkAdminAuth, checkCsrf } from "./auth";
import { __resetFirstRunForTests, getOrCreateClaim } from "./first-run";

// ── parseTokens ──────────────────────────────────────────────────────

describe("parseTokens", () => {
  it("returns empty array for undefined", () => {
    expect(parseTokens(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseTokens("")).toEqual([]);
  });

  it("parses a single token", () => {
    expect(parseTokens("abc123")).toEqual(["abc123"]);
  });

  it("parses multiple comma-separated tokens", () => {
    expect(parseTokens("token1,token2,token3")).toEqual(["token1", "token2", "token3"]);
  });

  it("trims whitespace around tokens", () => {
    expect(parseTokens("  token1 , token2  ,  token3  ")).toEqual(["token1", "token2", "token3"]);
  });

  it("drops empty segments from trailing comma", () => {
    expect(parseTokens("token1,token2,")).toEqual(["token1", "token2"]);
  });

  it("drops empty segments from leading comma", () => {
    expect(parseTokens(",token1,token2")).toEqual(["token1", "token2"]);
  });

  it("drops empty segments between commas", () => {
    expect(parseTokens("token1,,token2")).toEqual(["token1", "token2"]);
  });

  it("drops whitespace-only segments", () => {
    expect(parseTokens("token1, ,token2")).toEqual(["token1", "token2"]);
  });
});

// ── tokenId ──────────────────────────────────────────────────────────

describe("tokenId", () => {
  it("returns exactly 8 hex characters", () => {
    const id = tokenId("mysecrettoken");
    expect(id).toHaveLength(8);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic for the same token", () => {
    expect(tokenId("token-abc")).toBe(tokenId("token-abc"));
  });

  it("differs for different tokens", () => {
    expect(tokenId("token-abc")).not.toBe(tokenId("token-xyz"));
  });
});

// ── checkMcpAuth ─────────────────────────────────────────────────────

function makeRequest(token?: string): Request {
  // Set x-forwarded-for to a loopback IP so isLoopbackRequest returns
  // true via the proxy-header path. We avoid relying on URL-host trust
  // because v0.6 NIT-05 made that opt-in (MYMCP_TRUST_URL_HOST=1).
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-forwarded-for": "127.0.0.1",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new Request("http://localhost/api/mcp", { headers });
}

describe("checkMcpAuth", () => {
  const originalEnv = process.env.MCP_AUTH_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MCP_AUTH_TOKEN;
    } else {
      process.env.MCP_AUTH_TOKEN = originalEnv;
    }
  });

  it("allows loopback when no token is configured (dev convenience)", () => {
    delete process.env.MCP_AUTH_TOKEN;
    // makeRequest() points at http://localhost/... which is loopback.
    const { error, tokenId: tid } = checkMcpAuth(makeRequest());
    expect(error).toBeNull();
    expect(tid).toBeNull();
  });

  it("rejects non-loopback when no token is configured (fail-closed)", async () => {
    delete process.env.MCP_AUTH_TOKEN;
    // Simulate a request that appears to come from the public internet.
    const req = new Request("https://mymcp.example.com/api/mcp", {
      headers: {
        "x-forwarded-for": "203.0.113.42",
        "x-forwarded-host": "mymcp.example.com",
        "x-forwarded-proto": "https",
      },
    });
    const { error, tokenId: tid } = checkMcpAuth(req);
    expect(error).not.toBeNull();
    expect((error as Response).status).toBe(503);
    expect(tid).toBeNull();
  });

  it("accepts a valid single token", () => {
    process.env.MCP_AUTH_TOKEN = "mysingletoken1234567890";
    const { error, tokenId: tid } = checkMcpAuth(makeRequest("mysingletoken1234567890"));
    expect(error).toBeNull();
    expect(tid).toMatch(/^[0-9a-f]{8}$/);
  });

  it("rejects an invalid token when single token configured", () => {
    process.env.MCP_AUTH_TOKEN = "mysingletoken1234567890";
    const { error, tokenId: tid } = checkMcpAuth(makeRequest("wrongtoken"));
    expect(error).not.toBeNull();
    expect((error as Response).status).toBe(401);
    expect(tid).toBeNull();
  });

  it("accepts the first of multiple tokens", () => {
    process.env.MCP_AUTH_TOKEN = "firsttoken123456789,secondtoken123456789";
    const { error, tokenId: tid } = checkMcpAuth(makeRequest("firsttoken123456789"));
    expect(error).toBeNull();
    expect(tid).toMatch(/^[0-9a-f]{8}$/);
  });

  it("accepts the second of multiple tokens", () => {
    process.env.MCP_AUTH_TOKEN = "firsttoken123456789,secondtoken123456789";
    const { error, tokenId: tid } = checkMcpAuth(makeRequest("secondtoken123456789"));
    expect(error).toBeNull();
    expect(tid).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns different tokenIds for different tokens", () => {
    process.env.MCP_AUTH_TOKEN = "firsttoken123456789,secondtoken123456789";
    const { tokenId: tid1 } = checkMcpAuth(makeRequest("firsttoken123456789"));
    const { tokenId: tid2 } = checkMcpAuth(makeRequest("secondtoken123456789"));
    expect(tid1).not.toBe(tid2);
  });

  it("rejects a token not in the multi-token list", () => {
    process.env.MCP_AUTH_TOKEN = "firsttoken123456789,secondtoken123456789";
    const { error, tokenId: tid } = checkMcpAuth(makeRequest("thirdtoken123456789"));
    expect(error).not.toBeNull();
    expect((error as Response).status).toBe(401);
    expect(tid).toBeNull();
  });

  it("rejects a request with no token when tokens are configured", () => {
    process.env.MCP_AUTH_TOKEN = "mytoken1234567890";
    const { error, tokenId: tid } = checkMcpAuth(makeRequest());
    expect(error).not.toBeNull();
    expect((error as Response).status).toBe(401);
    expect(tid).toBeNull();
  });

  it("is backward-compatible: single token still works", () => {
    const token = "singlebackwardcompat123456";
    process.env.MCP_AUTH_TOKEN = token;
    const { error, tokenId: tid } = checkMcpAuth(makeRequest(token));
    expect(error).toBeNull();
    expect(tid).toBeTruthy();
  });

  it("handles whitespace around tokens in env var", () => {
    process.env.MCP_AUTH_TOKEN = "  tokenA1234567890  ,  tokenB1234567890  ";
    const { error: e1 } = checkMcpAuth(makeRequest("tokenA1234567890"));
    expect(e1).toBeNull();
    const { error: e2 } = checkMcpAuth(makeRequest("tokenB1234567890"));
    expect(e2).toBeNull();
  });
});

// ── checkCsrf ────────────────────────────────────────────────────────

describe("checkCsrf", () => {
  function mutatingRequest(headers: Record<string, string>): Request {
    return new Request("http://mymcp.example.com/api/config/env", {
      method: "PUT",
      headers,
    });
  }

  it("allows GET regardless of Origin", () => {
    const req = new Request("http://mymcp.example.com/api/config/env", {
      method: "GET",
      headers: { origin: "https://evil.com", host: "mymcp.example.com" },
    });
    expect(checkCsrf(req)).toBeNull();
  });

  it("allows request with no Origin header (non-browser caller)", () => {
    const req = mutatingRequest({ host: "mymcp.example.com" });
    expect(checkCsrf(req)).toBeNull();
  });

  it("allows request with same-origin Origin", () => {
    const req = mutatingRequest({
      origin: "http://mymcp.example.com",
      host: "mymcp.example.com",
    });
    expect(checkCsrf(req)).toBeNull();
  });

  it("rejects request with cross-origin Origin", () => {
    const req = mutatingRequest({
      origin: "https://evil.com",
      host: "mymcp.example.com",
    });
    const result = checkCsrf(req);
    expect(result).not.toBeNull();
    expect((result as Response).status).toBe(403);
  });

  it("rejects request with malformed Origin", () => {
    const req = mutatingRequest({
      origin: "not-a-url",
      host: "mymcp.example.com",
    });
    const result = checkCsrf(req);
    expect(result).not.toBeNull();
    expect((result as Response).status).toBe(403);
  });
});

// ── checkAdminAuth (first-run security) ──────────────────────────────

describe("checkAdminAuth — first-run mode", () => {
  const originalMcp = process.env.MCP_AUTH_TOKEN;
  const originalAdmin = process.env.ADMIN_AUTH_TOKEN;

  beforeEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.ADMIN_AUTH_TOKEN;
    __resetFirstRunForTests();
  });

  afterEach(() => {
    if (originalMcp === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = originalMcp;
    if (originalAdmin === undefined) delete process.env.ADMIN_AUTH_TOKEN;
    else process.env.ADMIN_AUTH_TOKEN = originalAdmin;
    __resetFirstRunForTests();
  });

  it("allows loopback requests when no token is configured", async () => {
    // x-forwarded-for points at loopback (proxy-header path). v0.6 NIT-05
    // made URL-host trust opt-in, so we test the proxy path explicitly.
    const req = new Request("http://localhost/api/admin/status", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(await checkAdminAuth(req)).toBeNull();
  });

  it("blocks a non-loopback request with no token and no claim cookie", async () => {
    const req = new Request("http://example.com/api/admin/status", {
      headers: { "x-forwarded-for": "8.8.8.8" },
    });
    const result = await checkAdminAuth(req);
    expect(result).not.toBeNull();
    expect((result as Response).status).toBe(401);
  });

  it("allows a non-loopback request that holds a valid first-run claim cookie", async () => {
    const claim = await getOrCreateClaim(
      new Request("http://example.com/api/welcome/claim", {
        headers: { "x-forwarded-for": "8.8.8.8" },
      })
    );
    const cookie = `mymcp_firstrun_claim=${encodeURIComponent(claim.cookieToSet || "")}`;
    const req = new Request("http://example.com/api/admin/status", {
      headers: { "x-forwarded-for": "8.8.8.8", cookie },
    });
    expect(await checkAdminAuth(req)).toBeNull();
  });
});

// ── SEC-A-03: admin/MCP token isolation in production ────────────────

describe("checkAdminAuth — SEC-A-03 production token isolation", () => {
  const origMcp = process.env.MCP_AUTH_TOKEN;
  const origAdmin = process.env.ADMIN_AUTH_TOKEN;
  const origFallback = process.env.KEBAB_ADMIN_TOKEN_FALLBACK;
  const origNodeEnv = process.env.NODE_ENV;
  const origVercel = process.env.VERCEL;

  beforeEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.ADMIN_AUTH_TOKEN;
    delete process.env.KEBAB_ADMIN_TOKEN_FALLBACK;
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    delete process.env.VERCEL;
    __resetFirstRunForTests();
  });

  afterEach(() => {
    if (origMcp === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = origMcp;
    if (origAdmin === undefined) delete process.env.ADMIN_AUTH_TOKEN;
    else process.env.ADMIN_AUTH_TOKEN = origAdmin;
    if (origFallback === undefined) delete process.env.KEBAB_ADMIN_TOKEN_FALLBACK;
    else process.env.KEBAB_ADMIN_TOKEN_FALLBACK = origFallback;
    if (origNodeEnv === undefined)
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string | undefined>).NODE_ENV = origNodeEnv;
    if (origVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = origVercel;
    __resetFirstRunForTests();
  });

  it("returns 503 in production when MCP_AUTH_TOKEN set but ADMIN_AUTH_TOKEN unset", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.MCP_AUTH_TOKEN = "mcp-secret-tok";
    const req = new Request("http://example.com/api/admin/status", {
      headers: { "x-forwarded-for": "8.8.8.8", authorization: "Bearer mcp-secret-tok" },
    });
    const result = await checkAdminAuth(req);
    expect(result).not.toBeNull();
    expect((result as Response).status).toBe(503);
  });

  it("returns 503 on Vercel when MCP_AUTH_TOKEN set but ADMIN_AUTH_TOKEN unset", async () => {
    process.env.VERCEL = "1";
    process.env.MCP_AUTH_TOKEN = "mcp-secret-tok";
    const req = new Request("http://example.com/api/admin/status", {
      headers: { "x-forwarded-for": "8.8.8.8", authorization: "Bearer mcp-secret-tok" },
    });
    const result = await checkAdminAuth(req);
    expect(result).not.toBeNull();
    expect((result as Response).status).toBe(503);
  });

  it("C1.7: a browser gets a plain-words HTML page explaining what to set and where", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.MCP_AUTH_TOKEN = "mcp-secret-tok";
    const req = new Request("http://example.com/config", {
      headers: {
        "x-forwarded-for": "8.8.8.8",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const res = (await checkAdminAuth(req)) as Response;
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("ADMIN_AUTH_TOKEN=");
    expect(html).toContain("KEBAB_ADMIN_TOKEN_FALLBACK=1");
    expect(html).toContain(".env");
    // Never echoes the configured token.
    expect(html).not.toContain("mcp-secret-tok");
  });

  it("C1.7: API clients keep a JSON 503 body", async () => {
    process.env.VERCEL = "1";
    process.env.MCP_AUTH_TOKEN = "mcp-secret-tok";
    const req = new Request("http://example.com/api/config/profiles", {
      headers: { "x-forwarded-for": "8.8.8.8", accept: "application/json" },
    });
    const res = (await checkAdminAuth(req)) as Response;
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("admin_auth_misconfigured");
    expect(body.message).toMatch(/ADMIN_AUTH_TOKEN is required/);
  });

  it("allows fallback when KEBAB_ADMIN_TOKEN_FALLBACK=1 explicitly opts in", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.MCP_AUTH_TOKEN = "shared-tok";
    process.env.KEBAB_ADMIN_TOKEN_FALLBACK = "1";
    const req = new Request("http://example.com/api/admin/status", {
      headers: { "x-forwarded-for": "8.8.8.8", authorization: "Bearer shared-tok" },
    });
    expect(await checkAdminAuth(req)).toBeNull();
  });

  it("does not block when both ADMIN_AUTH_TOKEN and MCP_AUTH_TOKEN are set in prod", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.MCP_AUTH_TOKEN = "mcp-tok";
    process.env.ADMIN_AUTH_TOKEN = "admin-tok";
    const req = new Request("http://example.com/api/admin/status", {
      headers: { "x-forwarded-for": "8.8.8.8", authorization: "Bearer admin-tok" },
    });
    expect(await checkAdminAuth(req)).toBeNull();
  });

  it("preserves dev convenience fallback (no NODE_ENV, no VERCEL)", async () => {
    process.env.MCP_AUTH_TOKEN = "shared-tok";
    const req = new Request("http://example.com/api/admin/status", {
      headers: { "x-forwarded-for": "8.8.8.8", authorization: "Bearer shared-tok" },
    });
    expect(await checkAdminAuth(req)).toBeNull();
  });
});

describe("admin misconfiguration page is shared with the proxy (audit C1.7)", () => {
  it("auth re-exports the dependency-free module", async () => {
    const auth = await import("./auth");
    const mod = await import("./admin-misconfigured");
    expect(auth.adminMisconfiguredResponse).toBe(mod.adminMisconfiguredResponse);
    const res = mod.adminMisconfiguredResponse(
      new Request("https://x.example/config", { headers: { accept: "text/html" } })
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/ADMIN_AUTH_TOKEN/);
  });
});
