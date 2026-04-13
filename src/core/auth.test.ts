import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseTokens, tokenId, checkMcpAuth } from "./auth";

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
  const headers: Record<string, string> = { "Content-Type": "application/json" };
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

  it("returns no error when no token is configured (open access)", () => {
    delete process.env.MCP_AUTH_TOKEN;
    const { error, tokenId: tid } = checkMcpAuth(makeRequest());
    expect(error).toBeNull();
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
