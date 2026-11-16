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
  list: async (prefix?: string) => [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)),
};
vi.mock("@/core/kv-store", () => ({
  getKVStore: () => kv,
  kvScanAll: async (_kv: unknown, match?: string) => {
    const prefix = match?.endsWith("*") ? match.slice(0, -1) : (match ?? "");
    return [...store.keys()].filter((k) => k.startsWith(prefix));
  },
}));
// devices.ts (loaded lazily by exchangeCode) reads the same store.
vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kv,
  getCurrentTenantId: () => null,
}));
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
  isCustomSchemeRedirect,
  MAX_CLIENT_METADATA_BYTES,
  MAX_REGISTERED_CLIENTS,
  PENDING_CLIENT_TTL_S,
  REFRESH_REUSE_GRACE_S,
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
    // Outside the grace window, reuse of a rotated token revokes the family.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + (REFRESH_REUSE_GRACE_S + 5) * 1000);
      await expect(
        refreshTokens({ refresh_token: t1.refresh_token, client_id: c.client_id })
      ).rejects.toMatchObject({ error: "invalid_grant" });
      expect(await resolveAccessToken(t2.access_token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a retried refresh within the grace window WITHOUT revoking the family (audit A3)", async () => {
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    const { code, verifier } = await authorized(c.client_id, "https://app.example/cb");
    const t1 = await exchangeCode({
      code,
      client_id: c.client_id,
      redirect_uri: "https://app.example/cb",
      code_verifier: verifier,
    });
    const t2 = await refreshTokens({ refresh_token: t1.refresh_token, client_id: c.client_id });
    // The client retries the same refresh (lost response): refused, family kept.
    await expect(
      refreshTokens({ refresh_token: t1.refresh_token, client_id: c.client_id })
    ).rejects.toMatchObject({ error: "invalid_grant" });
    expect(await resolveAccessToken(t2.access_token)).toBe("abcd0001");
    const t3 = await refreshTokens({ refresh_token: t2.refresh_token, client_id: c.client_id });
    expect(await resolveAccessToken(t3.access_token)).toBe("abcd0001");
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

describe("native-app redirect URIs (audit 2026-11, A3)", () => {
  it("accepts private-use schemes of native apps", () => {
    expect(isAllowedRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("vscode://vscode.github-authentication/did-authenticate")).toBe(
      true
    );
    expect(isAllowedRedirectUri("com.example.app:/oauth2redirect")).toBe(true);
    expect(isCustomSchemeRedirect("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
    expect(isCustomSchemeRedirect("https://claude.ai/cb")).toBe(false);
  });

  it("refuses dangerous schemes and plain http to another host", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "about:blank",
      "blob:https://evil.example/uuid",
      "http://evil.example.com/cb",
      "cursor://x/cb#frag",
      "notaurl",
    ]) {
      expect(isAllowedRedirectUri(bad), bad).toBe(false);
      expect(isCustomSchemeRedirect(bad), bad).toBe(bad.startsWith("cursor://"));
    }
  });

  it("registers a native client and runs the flow to its custom-scheme callback", async () => {
    const cb = "cursor://anysphere.cursor-mcp/oauth/callback";
    const c = await registerClient({ client_name: "Cursor", redirect_uris: [cb] });
    const { code, verifier } = await authorized(c.client_id, cb);
    await expect(
      exchangeCode({ code, client_id: c.client_id, redirect_uri: cb, code_verifier: verifier })
    ).resolves.toMatchObject({ token_type: "Bearer" });
    // Custom schemes match exactly (no loopback-style port leniency).
    await expect(
      validateAuthorize(
        {
          response_type: "code",
          client_id: c.client_id,
          redirect_uri: "cursor://anysphere.cursor-mcp/other",
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
        },
        ORIGIN
      )
    ).rejects.toMatchObject({ error: "invalid_redirect_uri" });
  });
});

describe("registration limits (audit 2026-11, A3)", () => {
  it("refuses metadata over the size cap", async () => {
    await expect(
      registerClient({
        redirect_uris: ["https://app.example/cb"],
        client_name: "x".repeat(MAX_CLIENT_METADATA_BYTES),
      })
    ).rejects.toMatchObject({ error: "invalid_client_metadata" });
  });

  it("keeps a new client 24 h until its first authorization, then a year", async () => {
    const setTtls = new Map<string, number | undefined>();
    const origSet = kv.set;
    kv.set = async (k: string, v: string, ttl?: number) => {
      setTtls.set(k, ttl);
      return origSet(k, v);
    };
    try {
      const c = await registerClient({ redirect_uris: ["https://app.example/cb"] });
      expect(setTtls.get(`oauth:client:${c.client_id}`)).toBe(PENDING_CLIENT_TTL_S);
      const { code, verifier } = await authorized(c.client_id, "https://app.example/cb");
      await exchangeCode({
        code,
        client_id: c.client_id,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      expect(setTtls.get(`oauth:client:${c.client_id}`)).toBe(365 * 24 * 60 * 60);
      expect(JSON.parse(store.get(`oauth:client:${c.client_id}`)!).authorized).toBe(true);
    } finally {
      kv.set = origSet;
    }
  });

  it("forgets a never-authorized client after 24 h even when the store ignores TTLs", async () => {
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    const rec = JSON.parse(store.get(`oauth:client:${c.client_id}`)!);
    rec.registered_at -= PENDING_CLIENT_TTL_S + 10;
    store.set(`oauth:client:${c.client_id}`, JSON.stringify(rec));
    await expect(getClient(c.client_id)).rejects.toMatchObject({ error: "invalid_client" });
  });

  function seedClients(n: number, authorized: boolean) {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < n; i++) {
      const id = `kc_seed_${authorized ? "a" : "u"}_${i}`;
      store.set(
        `oauth:client:${id}`,
        JSON.stringify({
          client_id: id,
          client_name: "seed",
          redirect_uris: ["https://app.example/cb"],
          kind: "dcr",
          registered_at: now - 1000 + i,
          authorized,
        })
      );
    }
  }

  it("evicts the oldest never-authorized client when the cap is reached", async () => {
    seedClients(MAX_REGISTERED_CLIENTS - 10, true);
    seedClients(10, false);
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    expect(store.has(`oauth:client:${c.client_id}`)).toBe(true);
    expect(store.has("oauth:client:kc_seed_u_0")).toBe(false); // oldest unused
    expect(store.has("oauth:client:kc_seed_u_1")).toBe(true);
    expect([...store.keys()].filter((k) => k.startsWith("oauth:client:"))).toHaveLength(
      MAX_REGISTERED_CLIENTS
    );
  });

  it("refuses with a 429-style error when every client is in use", async () => {
    seedClients(MAX_REGISTERED_CLIENTS, true);
    await expect(
      registerClient({ redirect_uris: ["https://app.example/cb"] })
    ).rejects.toMatchObject({ error: "temporarily_unavailable", status: 429 });
  });
});

describe("device created at code exchange, reused on re-authorization (audit 2026-11, A3)", () => {
  async function consent(clientId: string, redirect: string, fallbackId: string, access: string) {
    const { verifier, challenge } = pkce();
    const v = await validateAuthorize(
      {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      ORIGIN
    );
    const code = await issueCode(v, fallbackId, {
      label: "Claude",
      clientName: "Claude",
      skillTags: null,
      profile: null,
      access: access as "read" | "memory" | "full",
    });
    return { code, verifier };
  }
  const devices = () => [...store.keys()].filter((k) => k.startsWith("devices:"));

  it("creates no device until the code is exchanged, then binds tokens to it", async () => {
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    const a = await consent(c.client_id, "https://app.example/cb", "0000aaaa", "memory");
    expect(devices()).toEqual([]);
    const t = await exchangeCode({
      code: a.code,
      client_id: c.client_id,
      redirect_uri: "https://app.example/cb",
      code_verifier: a.verifier,
    });
    expect(devices()).toEqual(["devices:0000aaaa"]);
    expect(JSON.parse(store.get("devices:0000aaaa")!)).toMatchObject({
      access: "memory",
      oauth: { clientId: c.client_id },
    });
    expect(await resolveAccessToken(t.access_token)).toBe("0000aaaa");
  });

  it("reuses the client's existing device on re-authorization", async () => {
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    const first = await consent(c.client_id, "https://app.example/cb", "0000aaaa", "read");
    await exchangeCode({
      code: first.code,
      client_id: c.client_id,
      redirect_uri: "https://app.example/cb",
      code_verifier: first.verifier,
    });
    // The owner scoped its connectors in the dashboard meanwhile.
    const e = JSON.parse(store.get("devices:0000aaaa")!);
    store.set("devices:0000aaaa", JSON.stringify({ ...e, connectors: ["vault"] }));

    const second = await consent(c.client_id, "https://app.example/cb", "0000bbbb", "memory");
    const t = await exchangeCode({
      code: second.code,
      client_id: c.client_id,
      redirect_uri: "https://app.example/cb",
      code_verifier: second.verifier,
    });
    expect(devices()).toEqual(["devices:0000aaaa"]);
    expect(await resolveAccessToken(t.access_token)).toBe("0000aaaa");
    expect(JSON.parse(store.get("devices:0000aaaa")!)).toMatchObject({
      access: "memory",
      connectors: ["vault"],
    });
  });
});
