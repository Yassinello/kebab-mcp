/**
 * Audit 2026-11 (A2 / A3) — POST /api/oauth/authorize (the owner's consent):
 *   - only the dashboard cookie session of a same-origin browser request is
 *     accepted: a client holding the admin key cannot approve itself with
 *     `Authorization: Bearer`, nor from another site;
 *   - the chosen access level travels with the code and the device appears
 *     only once the code is exchanged.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";

const store = new Map<string, string>();
let envVars: Record<string, string> = {};

const kv = {
  kind: "filesystem" as const,
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
  list: async (prefix?: string) => [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)),
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

import { POST } from "../../app/api/oauth/authorize/route";
import { exchangeCode, registerClient } from "@/core/oauth";

const ADMIN = "admin-token-for-tests";
const ORIGIN = "https://kebab.test";
const CB = "https://app.example/cb";

const b64 = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function authorizeQuery() {
  const c = await registerClient({ client_name: "Claude", redirect_uris: [CB] });
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    response_type: "code",
    client_id: c.client_id,
    redirect_uri: CB,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st",
  });
  return { clientId: c.client_id, verifier, query: q.toString() };
}

function post(
  body: unknown,
  opts: { bearer?: boolean; site?: string | null; origin?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: "kebab.test",
  };
  if (opts.bearer) headers.authorization = `Bearer ${ADMIN}`;
  else headers.cookie = `kebab_admin_token=${ADMIN}`;
  if (opts.site !== null) headers["sec-fetch-site"] = opts.site ?? "same-origin";
  if (opts.origin) headers.origin = opts.origin;
  return POST(
    new Request(`${ORIGIN}/api/oauth/authorize`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  );
}

const devices = () => [...store.keys()].filter((k) => k.startsWith("devices:"));

beforeEach(() => {
  store.clear();
  envVars = { ADMIN_AUTH_TOKEN: ADMIN };
});

describe("POST /api/oauth/authorize", () => {
  it("refuses the admin key in an Authorization header (a client cannot approve itself)", async () => {
    const { query } = await authorizeQuery();
    const res = await post({ query, decision: "approve", access: "full" }, { bearer: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "browser_session_required" });
    expect(devices()).toEqual([]);
    expect([...store.keys()].some((k) => k.startsWith("oauth:code:"))).toBe(false);
  });

  it("refuses a request that is not a same-origin browser request", async () => {
    const { query } = await authorizeQuery();
    const cross = await post({ query, decision: "approve" }, { site: "cross-site" });
    expect(cross.status).toBe(403);
    const noHeaders = await post({ query, decision: "approve" }, { site: null });
    expect(noHeaders.status).toBe(403);
    const evil = await post(
      { query, decision: "approve" },
      { site: null, origin: "https://evil.example" }
    );
    expect(evil.status).toBe(403);
    expect([...store.keys()].some((k) => k.startsWith("oauth:code:"))).toBe(false);
  });

  it("accepts the dashboard session; the device appears at code exchange with the chosen level", async () => {
    const { clientId, verifier, query } = await authorizeQuery();
    const res = await post({ query, decision: "approve", label: "Claude", access: "memory" });
    expect(res.status).toBe(200);
    const { redirect } = (await res.json()) as { redirect: string };
    const url = new URL(redirect);
    expect(url.origin + url.pathname).toBe(CB);
    expect(url.searchParams.get("state")).toBe("st");
    const code = url.searchParams.get("code")!;
    expect(devices()).toEqual([]); // not before the exchange
    await exchangeCode({ code, client_id: clientId, redirect_uri: CB, code_verifier: verifier });
    expect(devices()).toHaveLength(1);
    expect(JSON.parse(store.get(devices()[0]!)!)).toMatchObject({
      label: "Claude",
      access: "memory",
      writeAllowed: false,
    });
  });

  it("fails closed to read-only when no valid access level is sent", async () => {
    const { clientId, verifier, query } = await authorizeQuery();
    const res = await post({ query, decision: "approve", access: "admin" });
    const code = new URL(((await res.json()) as { redirect: string }).redirect).searchParams.get(
      "code"
    )!;
    await exchangeCode({ code, client_id: clientId, redirect_uri: CB, code_verifier: verifier });
    expect(JSON.parse(store.get(devices()[0]!)!)).toMatchObject({ access: "read" });
  });

  it("denies with access_denied and creates nothing", async () => {
    const { query } = await authorizeQuery();
    const res = await post({ query, decision: "deny" });
    expect(
      new URL(((await res.json()) as { redirect: string }).redirect).searchParams.get("error")
    ).toBe("access_denied");
    expect(devices()).toEqual([]);
  });
});
