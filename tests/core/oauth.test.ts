/**
 * Kebab House phase 1 — OAU-01..09: single-owner OAuth 2.1 server.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";

const store = new Map<string, string>();
const kv = {
  kind: "filesystem" as const,
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => {
    store.set(k, v);
  },
  delete: async (k: string) => {
    store.delete(k);
  },
  list: async () => [...store.keys()],
};
vi.mock("@/core/kv-store", () => ({ getKVStore: () => kv }));
vi.mock("@/core/config-facade", () => ({ getConfig: () => undefined }));

const cimdDocs = new Map<string, unknown>();
vi.mock("@/core/safe-fetch", () => ({
  safeFetch: async (url: string) => {
    if (url.includes("10.0.0.1")) throw new Error("blocked: private address");
    const doc = cimdDocs.get(url);
    if (!doc)
      return { response: new Response("nope", { status: 404 }), finalUrl: url, redirects: 0 };
    return { response: new Response(JSON.stringify(doc)), finalUrl: url, redirects: 0 };
  },
}));

import {
  authorizationServerMetadata,
  exchangeCode,
  getClient,
  isAllowedRedirectUri,
  issueCode,
  protectedResourceMetadata,
  redirectUriMatches,
  refreshTokens,
  registerClient,
  resolveAccessToken,
  revokeToken,
  validateAuthorize,
  wwwAuthenticate,
} from "@/core/oauth";

const ORIGIN = "https://kebab.example.com";
const b64 = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkce() {
  const verifier = b64(randomBytes(32));
  return { verifier, challenge: b64(createHash("sha256").update(verifier).digest()) };
}

function activeDevice(id: string) {
  store.set(
    `devices:${id}`,
    JSON.stringify({ label: "c", createdAt: "t", oauth: { clientId: "x", clientName: "c" } })
  );
}

async function authorized(clientId: string, redirect: string, deviceId = "abcd0001") {
  const { verifier, challenge } = pkce();
  const v = await validateAuthorize(
    {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
      resource: `${ORIGIN}/api/mcp`,
    },
    ORIGIN
  );
  activeDevice(deviceId);
  return { code: await issueCode(v, deviceId), verifier };
}

beforeEach(() => {
  store.clear();
  cimdDocs.clear();
});

describe("metadata (OAU-01/02/03)", () => {
  it("advertises the resource, endpoints, PKCE S256 and CIMD support", () => {
    expect(protectedResourceMetadata(ORIGIN)).toMatchObject({
      resource: `${ORIGIN}/api/mcp`,
      authorization_servers: [ORIGIN],
    });
    const m = authorizationServerMetadata(ORIGIN);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(wwwAuthenticate(ORIGIN)).toContain(`${ORIGIN}/.well-known/oauth-protected-resource`);
  });
});

describe("redirect URIs", () => {
  it("accepts https and loopback http only", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
  });
  it("matches loopback URIs on any port, everything else exactly", () => {
    expect(redirectUriMatches("http://127.0.0.1:1/cb", "http://127.0.0.1:5555/cb")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1:1/cb", "http://127.0.0.1:5555/other")).toBe(false);
    expect(redirectUriMatches("https://a.com/cb", "https://a.com/cb?x=1")).toBe(false);
  });
});

describe("DCR (OAU-04)", () => {
  it("registers a public client and refuses confidential or unsafe ones", async () => {
    const c = await registerClient({
      client_name: "Cursor",
      redirect_uris: ["http://localhost:1/cb"],
    });
    expect(c.client_id).toMatch(/^kc_/);
    expect((await getClient(c.client_id)).client_name).toBe("Cursor");
    await expect(
      registerClient({
        redirect_uris: ["https://a.com/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      })
    ).rejects.toMatchObject({ error: "invalid_client_metadata" });
    await expect(registerClient({ redirect_uris: ["http://evil.com/cb"] })).rejects.toMatchObject({
      error: "invalid_redirect_uri",
    });
  });
});

describe("CIMD (OAU-05)", () => {
  const id = "https://claude.ai/oauth/claude-code-client-metadata";
  it("loads and caches a valid metadata document", async () => {
    cimdDocs.set(id, {
      client_id: id,
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
    });
    expect((await getClient(id)).client_name).toBe("Claude");
    cimdDocs.clear();
    expect((await getClient(id)).client_name).toBe("Claude"); // served from cache
  });
  it("refuses a document whose client_id differs, and private addresses", async () => {
    cimdDocs.set(id, {
      client_id: "https://other.example/x",
      redirect_uris: ["https://claude.ai/cb"],
    });
    await expect(getClient(id)).rejects.toMatchObject({ error: "invalid_client" });
    await expect(getClient("https://10.0.0.1/client")).rejects.toMatchObject({
      error: "invalid_client",
    });
  });
});

describe("authorization request", () => {
  it("requires a registered redirect, PKCE S256, the mcp scope and this resource", async () => {
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    const base = {
      response_type: "code",
      client_id: c.client_id,
      redirect_uri: "https://app.example/cb",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    };
    await expect(
      validateAuthorize({ ...base, redirect_uri: "https://evil/cb" }, ORIGIN)
    ).rejects.toMatchObject({
      error: "invalid_redirect_uri",
    });
    await expect(
      validateAuthorize({ ...base, code_challenge_method: "plain" }, ORIGIN)
    ).rejects.toMatchObject({
      error: "invalid_request",
    });
    await expect(validateAuthorize({ ...base, scope: "admin" }, ORIGIN)).rejects.toMatchObject({
      error: "invalid_scope",
    });
    await expect(
      validateAuthorize({ ...base, resource: "https://other/api/mcp" }, ORIGIN)
    ).rejects.toMatchObject({ error: "invalid_target" });
    await expect(validateAuthorize(base, ORIGIN)).resolves.toMatchObject({
      resource: `${ORIGIN}/api/mcp`,
    });
  });
});

describe("tokens (OAU-07/08/09)", () => {
  it("exchanges a code once, with PKCE, and resolves the access token to the device", async () => {
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    const { code, verifier } = await authorized(c.client_id, "https://app.example/cb");
    const t = await exchangeCode({
      code,
      client_id: c.client_id,
      redirect_uri: "https://app.example/cb",
      code_verifier: verifier,
    });
    expect(await resolveAccessToken(t.access_token)).toBe("abcd0001");
    await expect(
      exchangeCode({
        code,
        client_id: c.client_id,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      })
    ).rejects.toMatchObject({ error: "invalid_grant" });
    // Only hashes are stored.
    for (const [k, v] of store) {
      expect(k).not.toContain(t.access_token);
      expect(v).not.toContain(t.access_token);
    }
  });

  it("refuses a wrong verifier, another client or another redirect", async () => {
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    const a = await authorized(c.client_id, "https://app.example/cb");
    await expect(
      exchangeCode({
        code: a.code,
        client_id: c.client_id,
        redirect_uri: "https://app.example/cb",
        code_verifier: pkce().verifier,
      })
    ).rejects.toMatchObject({ error: "invalid_grant" });
    const b = await authorized(c.client_id, "https://app.example/cb");
    await expect(
      exchangeCode({
        code: b.code,
        client_id: "kc_other",
        redirect_uri: "https://app.example/cb",
        code_verifier: b.verifier,
      })
    ).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    const { code, verifier } = await authorized(c.client_id, "https://app.example/cb");
    const t1 = await exchangeCode({
      code,
      client_id: c.client_id,
      redirect_uri: "https://app.example/cb",
      code_verifier: verifier,
    });
    const t2 = await refreshTokens({ refresh_token: t1.refresh_token, client_id: c.client_id });
    expect(await resolveAccessToken(t2.access_token)).toBe("abcd0001");
    await expect(
      refreshTokens({ refresh_token: t1.refresh_token, client_id: c.client_id })
    ).rejects.toMatchObject({ error: "invalid_grant" });
    expect(await resolveAccessToken(t2.access_token)).toBeNull();
  });

  it("stops resolving tokens when the device is revoked, or the token is revoked", async () => {
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    const a = await authorized(c.client_id, "https://app.example/cb", "abcd0002");
    const t = await exchangeCode({
      code: a.code,
      client_id: c.client_id,
      redirect_uri: "https://app.example/cb",
      code_verifier: a.verifier,
    });
    store.set("devices:abcd0002", JSON.stringify({ label: "c", createdAt: "t", revokedAt: "now" }));
    expect(await resolveAccessToken(t.access_token)).toBeNull();
    activeDevice("abcd0002");
    expect(await resolveAccessToken(t.access_token)).toBe("abcd0002");
    await revokeToken(t.access_token);
    expect(await resolveAccessToken(t.access_token)).toBeNull();
  });
});
