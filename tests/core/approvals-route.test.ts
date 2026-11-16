/**
 * TRU-04 — POST /api/approvals/<id>: real admin auth (token + Origin CSRF
 * check), signature binding, approve / reject / single use.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const kvStore = new Map<string, string>();
let envVars: Record<string, string> = {};
let currentTenantId: string | null = null;

vi.mock("@/core/request-context", () => {
  const scoped = (k: string) => `${currentTenantId ?? ""}:${k}`;
  const kv = {
    kind: "filesystem" as const,
    get: async (k: string) => kvStore.get(scoped(k)) ?? null,
    set: async (k: string, v: string) => void kvStore.set(scoped(k), v),
    delete: async (k: string) => void kvStore.delete(scoped(k)),
    list: async () => [],
    setIfNotExists: async (k: string, v: string) => {
      if (kvStore.has(scoped(k))) return { ok: false as const, existing: kvStore.get(scoped(k))! };
      kvStore.set(scoped(k), v);
      return { ok: true as const };
    },
  };
  return {
    getContextKVStore: () => kv,
    getCurrentTenantId: () => currentTenantId,
    runWithTenant: async <T>(tenantId: string, fn: () => T) => {
      const prev = currentTenantId;
      currentTenantId = tenantId;
      try {
        return await fn();
      } finally {
        currentTenantId = prev;
      }
    },
    requestContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
    getCredential: (envKey: string) => envVars[envKey],
    runWithCredentials: <T>(_creds: Record<string, string>, fn: () => T) => fn(),
  };
});

vi.mock("@/core/config-facade", () => ({
  getConfig: (key: string) => envVars[key],
  getConfigInt: (key: string, fallback: number) => {
    const n = parseInt(envVars[key] ?? "", 10);
    return Number.isFinite(n) ? n : fallback;
  },
}));

vi.mock("@/core/signing-secret", async () => {
  const actual =
    await vi.importActual<typeof import("@/core/signing-secret")>("@/core/signing-secret");
  return { ...actual, getSigningSecret: async () => "1".repeat(64) };
});

import { POST } from "../../app/api/approvals/[id]/route";
import { createPreview, getPreview, consume, signApproval } from "@/core/approvals";

const ADMIN = "admin-token-for-tests";

/**
 * Audit 2026-11 (A2): decisions come from the dashboard page — admin cookie
 * session + same-origin browser request. `bearer` sends the key in an
 * Authorization header instead (what an AI client holding it would do).
 */
function post(
  id: string,
  body: unknown,
  opts: {
    token?: string | null;
    origin?: string;
    bearer?: boolean;
    site?: string | null;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: "kebab.test",
  };
  if (opts.token !== null) {
    if (opts.bearer) headers.authorization = `Bearer ${opts.token ?? ADMIN}`;
    else headers.cookie = `kebab_admin_token=${opts.token ?? ADMIN}`;
  }
  if (opts.site !== null) headers["sec-fetch-site"] = opts.site ?? "same-origin";
  if (opts.origin) headers.origin = opts.origin;
  const req = new Request(`https://kebab.test/api/approvals/${id}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

async function pending(tenant: string | null = null) {
  currentTenantId = tenant;
  const rec = await createPreview({
    tool: "whatsapp_send_message",
    summary: { account: "wa1", recipient: "Jane", text: "Hi", details: {} },
    payload: { args: { text: "Hi" } },
  });
  currentTenantId = null;
  return { id: rec.id, sig: await signApproval(rec.id, tenant) };
}

beforeEach(() => {
  kvStore.clear();
  envVars = { ADMIN_AUTH_TOKEN: ADMIN };
  currentTenantId = null;
});

describe("POST /api/approvals/<id>", () => {
  it("requires admin auth", async () => {
    const { id, sig } = await pending();
    expect((await post(id, { decision: "approve", sig }, { token: null })).status).toBe(401);
    expect((await post(id, { decision: "approve", sig }, { token: "wrong" })).status).toBe(401);
    expect((await getPreview(id))?.status).toBe("pending");
  });

  it("refuses a cross-origin POST (CSRF)", async () => {
    const { id, sig } = await pending();
    const res = await post(
      id,
      { decision: "approve", sig },
      { origin: "https://evil.example", site: "cross-site" }
    );
    expect(res.status).toBe(403);
    // Same without Sec-Fetch-Site: the Origin must be this instance.
    const res2 = await post(
      id,
      { decision: "approve", sig },
      { origin: "https://evil.example", site: null }
    );
    expect(res2.status).toBe(403);
    expect((await getPreview(id))?.status).toBe("pending");
  });

  it("refuses the admin key sent in an Authorization header (audit A2)", async () => {
    const { id, sig } = await pending();
    // An AI client holding the admin key cannot approve its own send.
    const res = await post(id, { decision: "approve", sig }, { bearer: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "browser_session_required" });
    // …not even when it also carries the cookie and same-origin headers.
    const req = new Request(`https://kebab.test/api/approvals/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "kebab.test",
        authorization: `Bearer ${ADMIN}`,
        cookie: `kebab_admin_token=${ADMIN}`,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ decision: "approve", sig }),
    });
    expect((await POST(req, { params: Promise.resolve({ id }) })).status).toBe(403);
    expect((await getPreview(id))?.status).toBe("pending");
  });

  it("refuses a non-browser request with the cookie (no Sec-Fetch-Site, no Origin)", async () => {
    const { id, sig } = await pending();
    const res = await post(id, { decision: "approve", sig }, { site: null });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "same_origin_required" });
    expect((await getPreview(id))?.status).toBe("pending");
  });

  it("accepts the cookie session with a same-origin Origin header", async () => {
    const { id, sig } = await pending();
    const res = await post(
      id,
      { decision: "approve", sig },
      { origin: "https://kebab.test", site: null }
    );
    expect(res.status).toBe(200);
  });

  it("refuses a bad or missing signature", async () => {
    const { id } = await pending();
    expect((await post(id, { decision: "approve", sig: "0".repeat(64) })).status).toBe(403);
    expect((await post(id, { decision: "approve" })).status).toBe(403);
    expect((await getPreview(id))?.status).toBe("pending");
  });

  it("approve marks the preview approved; it then executes once", async () => {
    const { id, sig } = await pending();
    const res = await post(id, { decision: "approve", sig }, { origin: "https://kebab.test" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "approved" });
    expect((await consume(id, "whatsapp_send_message")).ok).toBe(true);
    // Deciding again after execution is a conflict.
    expect((await post(id, { decision: "reject", sig })).status).toBe(409);
  });

  it("reject deletes the preview", async () => {
    const { id, sig } = await pending();
    expect((await post(id, { decision: "reject", sig })).status).toBe(200);
    expect(await getPreview(id)).toBeNull();
    expect((await post(id, { decision: "approve", sig })).status).toBe(404);
  });

  it("works in the tenant the link was signed for, and only that one", async () => {
    const { id, sig } = await pending("acme");
    expect((await post(id, { decision: "approve", sig })).status).toBe(403); // tenant missing
    expect((await post(id, { decision: "approve", sig, tenant: "other" })).status).toBe(403);
    expect((await post(id, { decision: "approve", sig, tenant: "acme" })).status).toBe(200);
    currentTenantId = "acme";
    expect((await getPreview(id))?.status).toBe("approved");
  });

  it("validates the decision and the id", async () => {
    const { id, sig } = await pending();
    expect((await post(id, { decision: "maybe", sig })).status).toBe(400);
    expect((await post("not-an-id", { decision: "approve", sig })).status).toBe(404);
  });
});
