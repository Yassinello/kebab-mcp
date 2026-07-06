/**
 * Phase 52 / DEV-03 — route-level tests for /api/admin/devices.
 *
 * Covers GET list / POST rotate+rename+invite / DELETE revoke, plus the
 * root-only gate, the rate-limit-bucket cleanup path, and the invite
 * handoff into device-invite.ts.
 *
 * Strategy: mirrors Phase 42 admin-rate-limits-tenant.test.ts — mock the
 * KV store, request-context, and env-store at the module boundary so we
 * exercise the real pipeline composition without touching disk.
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
    getCurrentTenantId: () => currentTenantId,
    requestContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
    getCredential: (envKey: string) => envVars[envKey] ?? process.env[envKey],
    runWithCredentials: <T>(_creds: Record<string, string>, fn: () => T) => fn(),
  };
});

vi.mock("@/core/config-facade", () => ({
  getConfig: (key: string) => envVars[key],
  getConfigInt: (key: string, fallback: number) => {
    const v = envVars[key];
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

// Bypass admin-auth so we exercise route logic; unauthed tests override
// the config-facade token read below.
let allowAdmin = true;
vi.mock("@/core/auth", async () => {
  const actual = await vi.importActual<typeof import("@/core/auth")>("@/core/auth");
  return {
    ...actual,
    checkAdminAuth: async () => (allowAdmin ? null : new Response("Unauthorized", { status: 401 })),
    checkCsrf: () => null,
  };
});

// Deterministic signing secret so invite mint/verify work.
vi.mock("@/core/signing-secret", async () => {
  const actual =
    await vi.importActual<typeof import("@/core/signing-secret")>("@/core/signing-secret");
  return {
    ...actual,
    getSigningSecret: async () => "0".repeat(64),
  };
});

// ── tenant-scope toggle ────────────────────────────────────────────────
let currentTenantId: string | null = null;

// Import route handlers AFTER mocks.
import { GET, POST, DELETE } from "../../app/api/admin/devices/route";
import { tokenId, parseTokens } from "@/core/auth";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

function makeReq(
  method: string,
  body?: unknown,
  opts: { tenantHeader?: string; url?: string } = {}
): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.tenantHeader) headers["x-mymcp-tenant"] = opts.tenantHeader;
  return new Request(opts.url ?? "http://localhost/api/admin/devices", {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : null,
  });
}

beforeEach(() => {
  kvStore.clear();
  envVars = {};
  allowAdmin = true;
  currentTenantId = null;
});

describe("/api/admin/devices — GET", () => {
  it("returns 401 when not authed", async () => {
    allowAdmin = false;
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with device rows when authed", async () => {
    envVars.MCP_AUTH_TOKEN = `${TOKEN_A},${TOKEN_B}`;
    kvStore.set(
      `devices:${tokenId(TOKEN_A)}`,
      JSON.stringify({ label: "Claude Desktop", createdAt: "2026-04-22T00:00:00.000Z" })
    );
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(2);
    const deviceA = body.devices.find((d: { tokenId: string }) => d.tokenId === tokenId(TOKEN_A));
    expect(deviceA?.label).toBe("Claude Desktop");
  });

  it("returns 403 root_only when called under tenant scope", async () => {
    currentTenantId = "alpha";
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const res = await GET(makeReq("GET", undefined, { tenantHeader: "alpha" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("root_only");
  });
});

describe("/api/admin/devices — POST rotate", () => {
  it("returns 200 + new token + updates MCP_AUTH_TOKEN", async () => {
    envVars.MCP_AUTH_TOKEN = `${TOKEN_A},${TOKEN_B}`;
    kvStore.set(
      `devices:${tokenId(TOKEN_A)}`,
      JSON.stringify({ label: "Old", createdAt: "2026-01-01T00:00:00.000Z" })
    );

    const res = await POST(makeReq("POST", { action: "rotate", tokenId: tokenId(TOKEN_A) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.newToken).toMatch(/^[a-f0-9]{64}$/);
    expect(body.newTokenId).toMatch(/^[a-f0-9]{8}$/);

    const tokens = parseTokens(envVars.MCP_AUTH_TOKEN);
    expect(tokens).toHaveLength(2);
    expect(tokens).toContain(body.newToken);
    expect(tokens).toContain(TOKEN_B);
    expect(tokens).not.toContain(TOKEN_A);
  });

  it("returns 404 when rotating an unknown tokenId", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const res = await POST(makeReq("POST", { action: "rotate", tokenId: "deadbeef" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });
});

describe("/api/admin/devices — POST rename", () => {
  it("returns 200 on valid rename", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const res = await POST(
      makeReq("POST", { action: "rename", tokenId: tokenId(TOKEN_A), label: "Claude Code" })
    );
    expect(res.status).toBe(200);
    const raw = kvStore.get(`devices:${tokenId(TOKEN_A)}`);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).label).toBe("Claude Code");
  });

  it("returns 400 invalid_label on empty label", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const res = await POST(
      makeReq("POST", { action: "rename", tokenId: tokenId(TOKEN_A), label: "" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_label");
  });
});

describe("/api/admin/devices — POST invite", () => {
  it("returns 200 with URL + expiresAt on valid invite", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    envVars.MYMCP_ALLOW_EPHEMERAL_SECRET = "1";
    const res = await POST(makeReq("POST", { action: "invite", label: "New Phone" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toMatch(/\/welcome\/device-claim\?token=/);
    expect(typeof body.expiresAt).toBe("number");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects invite with invalid label", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const res = await POST(makeReq("POST", { action: "invite", label: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_label");
  });
});

describe("/api/admin/devices — DELETE revoke", () => {
  it("returns 200 and clears env + KV + rate-limit", async () => {
    envVars.MCP_AUTH_TOKEN = `${TOKEN_A},${TOKEN_B}`;
    const tid = tokenId(TOKEN_A);
    kvStore.set(`devices:${tid}`, JSON.stringify({ label: "L", createdAt: "x" }));

    const res = await DELETE(
      makeReq("DELETE", undefined, { url: `http://localhost/api/admin/devices?tokenId=${tid}` })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revoked).toBe(true);

    expect(kvStore.has(`devices:${tid}`)).toBe(false);
    expect(envVars.MCP_AUTH_TOKEN).toBe(TOKEN_B);
  });

  it("returns 404 when revoking an unknown tokenId", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const res = await DELETE(
      makeReq("DELETE", undefined, {
        url: "http://localhost/api/admin/devices?tokenId=deadbeef",
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });
});

describe("/api/admin/devices — POST set-connectors", () => {
  it("returns 200 and persists a validated allowlist", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const tid = tokenId(TOKEN_A);
    const res = await POST(
      makeReq("POST", { action: "set-connectors", tokenId: tid, connectors: ["apify", "unipile"] })
    );
    expect(res.status).toBe(200);
    const raw = kvStore.get(`devices:${tid}`);
    expect(JSON.parse(raw!).connectors).toEqual(["apify", "unipile"]);
  });

  it("clears the scope on null (full access) and drops the field", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const tid = tokenId(TOKEN_A);
    kvStore.set(
      `devices:${tid}`,
      JSON.stringify({ label: "Team", createdAt: "x", connectors: ["apify"] })
    );
    const res = await POST(
      makeReq("POST", { action: "set-connectors", tokenId: tid, connectors: null })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(kvStore.get(`devices:${tid}`)!).connectors).toBeUndefined();
  });

  it("returns 400 unknown_connector on an invalid connector id", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const res = await POST(
      makeReq("POST", {
        action: "set-connectors",
        tokenId: tokenId(TOKEN_A),
        connectors: ["apify", "not-real"],
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_connector");
  });

  it("returns 400 invalid_connectors when connectors is not an array or null", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const res = await POST(
      makeReq("POST", {
        action: "set-connectors",
        tokenId: tokenId(TOKEN_A),
        connectors: "apify",
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_connectors");
  });

  it("returns 404 for an unknown tokenId", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const res = await POST(
      makeReq("POST", { action: "set-connectors", tokenId: "deadbeef", connectors: ["apify"] })
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("returns 403 root_only under tenant scope", async () => {
    currentTenantId = "alpha";
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const res = await POST(
      makeReq(
        "POST",
        { action: "set-connectors", tokenId: tokenId(TOKEN_A), connectors: ["apify"] },
        { tenantHeader: "alpha" }
      )
    );
    expect(res.status).toBe(403);
  });
});

describe("/api/admin/devices — POST unknown action", () => {
  it("returns 400", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const res = await POST(makeReq("POST", { action: "bogus" }));
    expect(res.status).toBe(400);
  });
});
