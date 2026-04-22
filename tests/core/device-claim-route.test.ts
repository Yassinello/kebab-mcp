/**
 * Phase 52 / DEV-04 — route-level tests for /api/welcome/device-claim.
 *
 * Covers valid claim, expired (410), replay (409), malformed (400), and
 * bad signature (401). Mocks getSigningSecret so HMAC is deterministic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const kvStore = new Map<string, string>();
let envVars: Record<string, string> = {};

vi.mock("@/core/request-context", () => {
  const kv = {
    kind: "filesystem" as const,
    get: async (k: string) => kvStore.get(k) ?? null,
    set: async (k: string, v: string) => {
      kvStore.set(k, v);
    },
    delete: async (k: string) => {
      kvStore.delete(k);
    },
    list: async () => Array.from(kvStore.keys()),
    setIfNotExists: async (k: string, v: string) => {
      if (kvStore.has(k)) return { ok: false as const, existing: kvStore.get(k) ?? "" };
      kvStore.set(k, v);
      return { ok: true as const };
    },
  };
  return {
    getContextKVStore: () => kv,
    getCurrentTenantId: () => null,
    requestContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
    getCredential: (k: string) => envVars[k] ?? process.env[k],
    runWithCredentials: <T>(_c: Record<string, string>, fn: () => T) => fn(),
  };
});

vi.mock("@/core/config-facade", () => ({
  getConfig: (k: string) => envVars[k],
  getConfigInt: (k: string, fallback: number) => {
    const v = envVars[k];
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) ? n : fallback;
  },
}));

vi.mock("@/core/env-store", () => ({
  getEnvStore: () => ({
    kind: "filesystem" as const,
    read: async () => ({ ...envVars }),
    write: async (vars: Record<string, string>) => {
      envVars = { ...envVars, ...vars };
      return { written: Object.keys(vars).length };
    },
    delete: async (key: string) => {
      const had = key in envVars;
      delete envVars[key];
      return { deleted: had };
    },
  }),
}));

vi.mock("@/core/signing-secret", () => ({
  getSigningSecret: async () => "0".repeat(64),
  SigningSecretUnavailableError: class extends Error {},
}));

import { POST } from "../../app/api/welcome/device-claim/route";
import { mintDeviceInvite } from "@/core/device-invite";
import { parseTokens } from "@/core/auth";

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/welcome/device-claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  kvStore.clear();
  envVars = {};
});

async function extractToken(): Promise<string> {
  const { url } = await mintDeviceInvite({ tenantId: null, label: "Laptop" });
  return new URL(url, "http://x").searchParams.get("token")!;
}

describe("/api/welcome/device-claim — POST", () => {
  it("returns 400 when body has no token", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("mints a fresh token and appends it to MCP_AUTH_TOKEN on valid claim", async () => {
    envVars.MCP_AUTH_TOKEN = "a".repeat(64);
    const token = await extractToken();
    const res = await POST(makeReq({ token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^[a-f0-9]{64}$/);
    expect(body.tokenId).toMatch(/^[a-f0-9]{8}$/);
    expect(body.label).toBe("Laptop");
    const list = parseTokens(envVars.MCP_AUTH_TOKEN);
    expect(list).toHaveLength(2);
    expect(list).toContain(body.token);
  });

  it("returns 409 already_consumed on replay", async () => {
    const token = await extractToken();
    const first = await POST(makeReq({ token }));
    expect(first.status).toBe(200);
    const second = await POST(makeReq({ token }));
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBe("already_consumed");
  });

  it("returns 410 expired on past expiry", async () => {
    envVars.KEBAB_DEVICE_INVITE_TTL_H = "0.0001";
    const token = await extractToken();
    await new Promise((r) => setTimeout(r, 500));
    const res = await POST(makeReq({ token }));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("expired");
  });

  it("returns 400 on malformed token", async () => {
    const res = await POST(makeReq({ token: "not-a-token" }));
    expect(res.status).toBe(400);
  });

  it("returns 401 on tampered signature", async () => {
    const token = await extractToken();
    const [payload, sig] = token.split(".");
    // Flip one hex char at the end of the signature.
    const lastChar = sig!.slice(-1);
    const swap = lastChar === "0" ? "1" : "0";
    const tampered = `${payload}.${sig!.slice(0, -1)}${swap}`;
    const res = await POST(makeReq({ token: tampered }));
    expect(res.status).toBe(401);
  });
});
