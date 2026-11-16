/**
 * Audit 2026-11 (A3) — the anonymous OAuth endpoints are rate-limited per IP
 * even when the global limiter flag (MYMCP_RATE_LIMIT_ENABLED) is off:
 * registration 10 per hour, token and revocation 60 per minute.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, string>();
let envVars: Record<string, string> = {};

const kv = {
  kind: "filesystem" as const,
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
  list: async (prefix?: string) => [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)),
  incr: async (k: string) => {
    const n = Number(store.get(k) ?? 0) + 1;
    store.set(k, String(n));
    return n;
  },
};

vi.mock("@/core/kv-store", () => ({
  getKVStore: () => kv,
  kvScanAll: async (_kv: unknown, match?: string) => {
    const prefix = match?.endsWith("*") ? match.slice(0, -1) : (match ?? "");
    return [...store.keys()].filter((k) => k.startsWith(prefix));
  },
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kv,
  getCurrentTenantId: () => null,
  requestContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
  getCredential: (envKey: string) => envVars[envKey],
  runWithCredentials: <T>(_creds: Record<string, string>, fn: () => T) => fn(),
}));

vi.mock("@/core/config-facade", () => ({
  getConfig: (key: string) => envVars[key],
  getConfigInt: (key: string, fallback: number) => {
    const n = parseInt(envVars[key] ?? "", 10);
    return Number.isFinite(n) ? n : fallback;
  },
}));

import { POST as register } from "../../app/api/oauth/register/route";
import { POST as token } from "../../app/api/oauth/token/route";
import { POST as revoke } from "../../app/api/oauth/revoke/route";

function req(path: string, ip: string, body: string, type: string): Request {
  return new Request(`https://kebab.test${path}`, {
    method: "POST",
    headers: { "content-type": type, "x-forwarded-for": ip },
    body,
  });
}

const regBody = JSON.stringify({ client_name: "c", redirect_uris: ["https://app.example/cb"] });

beforeEach(() => {
  store.clear();
  // MYMCP_RATE_LIMIT_ENABLED is NOT set. VERCEL=1 so the client IP is read
  // from x-forwarded-for (elsewhere every caller shares the "unknown" key).
  envVars = { VERCEL: "1" };
});

describe("OAuth endpoints rate limits (always on)", () => {
  it("registration: 10 per hour per IP, then 429; another IP is unaffected", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await register(
        req("/api/oauth/register", "203.0.113.7", regBody, "application/json")
      );
      expect(r.status).toBe(201);
    }
    const blocked = await register(
      req("/api/oauth/register", "203.0.113.7", regBody, "application/json")
    );
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(60);
    const other = await register(
      req("/api/oauth/register", "198.51.100.2", regBody, "application/json")
    );
    expect(other.status).toBe(201);
    // Only the 11 accepted registrations were stored.
    expect([...store.keys()].filter((k) => k.startsWith("oauth:client:"))).toHaveLength(11);
  });

  it("registration refuses oversized metadata", async () => {
    const big = JSON.stringify({
      client_name: "x".repeat(5000),
      redirect_uris: ["https://app.example/cb"],
    });
    const r = await register(req("/api/oauth/register", "203.0.113.8", big, "application/json"));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("token and revocation: 60 per minute per IP", async () => {
    const form = "grant_type=refresh_token&client_id=kc_x&refresh_token=nope";
    const type = "application/x-www-form-urlencoded";
    for (let i = 0; i < 60; i++) {
      expect((await token(req("/api/oauth/token", "203.0.113.9", form, type))).status).toBe(400);
      expect((await revoke(req("/api/oauth/revoke", "203.0.113.9", "token=x", type))).status).toBe(
        200
      );
    }
    expect((await token(req("/api/oauth/token", "203.0.113.9", form, type))).status).toBe(429);
    expect((await revoke(req("/api/oauth/revoke", "203.0.113.9", "token=x", type))).status).toBe(
      429
    );
  });
});
