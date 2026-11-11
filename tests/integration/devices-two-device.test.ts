/**
 * Phase 52 / DEV-05 — 2-device end-to-end integration test.
 *
 * Exercises the full user story in-process (zero HTTP / zero Docker):
 *
 *   1. Operator mints device A via admin invite flow (device A was
 *      seeded by welcome-init in production; we seed MCP_AUTH_TOKEN
 *      directly here to keep the test focused on Phase 52's surface).
 *   2. Operator generates invite for device B via POST
 *      /api/admin/devices { action:"invite" }.
 *   3. Device B claims via POST /api/welcome/device-claim → receives
 *      its own 64-hex token; MCP_AUTH_TOKEN now carries A + B.
 *   4. Operator rotates A via POST /api/admin/devices { action:"rotate" }
 *      → old tokenA gone, new tokenA2 in list, B untouched.
 *   5. Operator revokes A2 via DELETE
 *      /api/admin/devices?tokenId=<A2> → only B remains.
 *   6. Replay: device B re-POSTs the same (consumed) claim token → 409.
 *   7. Expiry: mint a fresh invite with KEBAB_DEVICE_INVITE_TTL_H
 *      tightened to 0.0001h (≈0.36s), await 500ms, claim → 410.
 *
 * Assertions cover the end-state of MCP_AUTH_TOKEN at each step so a
 * regression in rotate/revoke splicing is caught without relying on a
 * live HTTP surface.
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
    list: async (prefix?: string) =>
      Array.from(kvStore.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true)),
    scan: async (cursor: string, opts?: { match?: string; count?: number }) => {
      const match = opts?.match ?? "*";
      const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
      const all = Array.from(kvStore.keys()).filter((k) =>
        match.endsWith("*") ? k.startsWith(prefix) : k === match
      );
      const offset = cursor === "0" ? 0 : parseInt(cursor, 10) || 0;
      const count = opts?.count ?? 100;
      const slice = all.slice(offset, offset + count);
      const nextOffset = offset + count;
      const nextCursor = nextOffset >= all.length ? "0" : String(nextOffset);
      return { cursor: nextCursor, keys: slice };
    },
    setIfNotExists: async (k: string, v: string) => {
      if (kvStore.has(k)) return { ok: false as const, existing: kvStore.get(k) ?? "" };
      kvStore.set(k, v);
      return { ok: true as const };
    },
  };
  return {
    getContextKVStore: () => kv,
    getCurrentTenantId: () => null,
    requestContext: { run: <T>(_c: unknown, fn: () => T) => fn(), getStore: () => undefined },
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

vi.mock("@/core/auth", async () => {
  const actual = await vi.importActual<typeof import("@/core/auth")>("@/core/auth");
  return {
    ...actual,
    checkAdminAuth: async () => null,
    checkCsrf: () => null,
  };
});

vi.mock("@/core/signing-secret", () => ({
  getSigningSecret: async () => "0".repeat(64),
  SigningSecretUnavailableError: class extends Error {},
}));

import { POST as adminPost, DELETE as adminDelete } from "../../app/api/admin/devices/route";
import { POST as claimPost } from "../../app/api/welcome/device-claim/route";
import { parseTokens, tokenId } from "@/core/auth";

const TOKEN_A = "a".repeat(64);

function adminReq(method: string, body?: unknown, url?: string): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url ?? "http://localhost/api/admin/devices", {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : null,
  });
}

function claimReq(body: unknown): Request {
  return new Request("http://localhost/api/welcome/device-claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function extractClaimToken(url: string): string {
  return new URL(url, "http://x").searchParams.get("token")!;
}

beforeEach(() => {
  kvStore.clear();
  envVars = {};
});

describe("devices-two-device integration (DEV-05)", () => {
  it("mint A → invite B → claim B → rotate A → revoke A → replay → expiry", async () => {
    // Step 1: Seed device A (production: welcome-init does this).
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const tidA = tokenId(TOKEN_A);
    kvStore.set(
      `devices:${tidA}`,
      JSON.stringify({ label: "Device A", createdAt: "2026-04-22T00:00:00.000Z" })
    );

    // Step 2: Admin mints invite for device B.
    const inviteRes = await adminPost(adminReq("POST", { action: "invite", label: "Device B" }));
    expect(inviteRes.status).toBe(200);
    const inviteBody = await inviteRes.json();
    expect(inviteBody.url).toMatch(/^\/welcome\/device-claim\?token=/);
    const inviteToken = extractClaimToken(inviteBody.url);

    // Step 3: Device B claims.
    const claimRes = await claimPost(claimReq({ token: inviteToken }));
    expect(claimRes.status).toBe(200);
    const claimBody = await claimRes.json();
    expect(claimBody.token).toMatch(/^[a-f0-9]{64}$/);
    expect(claimBody.label).toBe("Device B");
    const tokenB = claimBody.token as string;
    const tidB = tokenId(tokenB);

    // Env now carries A + B; KV has both device labels.
    let tokens = parseTokens(envVars.MCP_AUTH_TOKEN);
    expect(tokens).toHaveLength(2);
    expect(tokens).toContain(TOKEN_A);
    expect(tokens).toContain(tokenB);
    expect(kvStore.has(`devices:${tidA}`)).toBe(true);
    expect(kvStore.has(`devices:${tidB}`)).toBe(true);

    // Step 4: Rotate A → tokenA disappears, A2 takes its place, B untouched.
    const rotateRes = await adminPost(adminReq("POST", { action: "rotate", tokenId: tidA }));
    expect(rotateRes.status).toBe(200);
    const rotateBody = await rotateRes.json();
    const tokenA2 = rotateBody.newToken as string;
    const tidA2 = rotateBody.newTokenId as string;
    expect(tokenA2).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenA2).not.toBe(TOKEN_A);

    tokens = parseTokens(envVars.MCP_AUTH_TOKEN);
    expect(tokens).toHaveLength(2);
    expect(tokens).toContain(tokenA2);
    expect(tokens).toContain(tokenB);
    expect(tokens).not.toContain(TOKEN_A);
    // SEC-06: old tokenId keeps a revocation tombstone
    expect(JSON.parse(kvStore.get(`devices:${tidA}`)!).revokedAt).toBeTruthy();
    expect(kvStore.has(`devices:${tidA2}`)).toBe(true);
    expect(kvStore.has(`devices:${tidB}`)).toBe(true);

    // Step 5: Revoke A2 — only B remains.
    const revokeRes = await adminDelete(
      adminReq("DELETE", undefined, `http://localhost/api/admin/devices?tokenId=${tidA2}`)
    );
    expect(revokeRes.status).toBe(200);
    const revokeBody = await revokeRes.json();
    expect(revokeBody.revoked).toBe(true);

    tokens = parseTokens(envVars.MCP_AUTH_TOKEN);
    expect(tokens).toEqual([tokenB]);
    expect(JSON.parse(kvStore.get(`devices:${tidA2}`)!).revokedAt).toBeTruthy();
    expect(kvStore.has(`devices:${tidB}`)).toBe(true);

    // Step 6: Replay invite — nonce already consumed.
    const replayRes = await claimPost(claimReq({ token: inviteToken }));
    expect(replayRes.status).toBe(409);
    const replayBody = await replayRes.json();
    expect(replayBody.error).toBe("already_consumed");

    // Step 7: Expiry — mint a fresh invite with a sub-second TTL, wait,
    // claim returns 410.
    envVars.KEBAB_DEVICE_INVITE_TTL_H = "0.0001"; // ≈0.36s
    const shortInvite = await adminPost(adminReq("POST", { action: "invite", label: "Device C" }));
    const shortBody = await shortInvite.json();
    const shortToken = extractClaimToken(shortBody.url);
    await new Promise((r) => setTimeout(r, 500));
    const expiredRes = await claimPost(claimReq({ token: shortToken }));
    expect(expiredRes.status).toBe(410);
    const expiredBody = await expiredRes.json();
    expect(expiredBody.error).toBe("expired");

    // MCP_AUTH_TOKEN unchanged by the expired claim.
    tokens = parseTokens(envVars.MCP_AUTH_TOKEN);
    expect(tokens).toEqual([tokenB]);
  });
});
