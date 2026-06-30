/**
 * v0.19 (GMATL) — Google tool account selection.
 *
 * Proves the optional `account` param threads the SELECTED account's token
 * set + slug down through resolveGoogleTokens → getGoogleAccessToken, so the
 * OAuth refresh exchange uses the right account's refresh token (and a
 * distinct per-slug cache bucket).
 *   - gmail_inbox(account:"work") vs (account:"perso") exchange DIFFERENT
 *     refresh tokens at the Google token endpoint.
 *   - omitting `account` with 2 accounts + no pinned default returns the
 *     error_account_required envelope listing the names (NOT a throw).
 *   - no account configured returns the not-configured envelope.
 *
 * Mock strategy: stub `resolveConnectorAccount` (what the resolver helper
 * calls). The google-auth + google-fetch layers run for real against a
 * mocked global `fetch`, so the outbound OAuth refresh body is the assertion
 * target.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AccountResolution } from "@/core/connector-accounts";

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));

vi.mock("@/core/connector-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/connector-accounts")>();
  return { ...actual, resolveConnectorAccount: resolveMock };
});

// KV store stub so the per-slug access-token cache has somewhere to write.
const STORE = new Map<string, string>();
vi.mock("@/core/request-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/request-context")>();
  return {
    ...actual,
    getContextKVStore: () => ({
      get: async (k: string) => STORE.get(k) ?? null,
      set: async (k: string, v: string) => void STORE.set(k, v),
      delete: async (k: string) => void STORE.delete(k),
      list: async () => Array.from(STORE.keys()),
    }),
  };
});

import { handleGmailInbox } from "../gmail-inbox";
import { __resetGoogleTokenCacheForTests } from "../../lib/google-auth";

function acct(slug: string, name: string, refresh: string): AccountResolution {
  return {
    account: {
      slug,
      name,
      tokens: {
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REFRESH_TOKEN: refresh,
      },
    },
  };
}

const fetchSpy = vi.fn();

/** Pull the form-encoded refresh_token off an OAuth token-exchange call. */
function refreshTokenOf(call: unknown[]): string | null {
  const init = call[1] as RequestInit | undefined;
  const body = init?.body;
  if (typeof body !== "string" && !(body instanceof URLSearchParams)) return null;
  return new URLSearchParams(body as string).get("refresh_token");
}

describe("v0.19 — Google gmail_inbox account selection", () => {
  beforeEach(() => {
    STORE.clear();
    __resetGoogleTokenCacheForTests();
    resolveMock.mockReset();
    fetchSpy.mockReset();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as typeof fetch);
    // Default fetch impl: OAuth token endpoint → access token; Gmail list → empty.
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("account:'work' exchanges the work refresh token", async () => {
    resolveMock.mockResolvedValueOnce(acct("work", "work@x.com", "rt-work"));
    await handleGmailInbox({ account: "work" });
    const oauthCall = fetchSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("oauth2.googleapis.com")
    );
    expect(oauthCall).toBeDefined();
    expect(refreshTokenOf(oauthCall!)).toBe("rt-work");
  });

  it("account:'perso' exchanges the perso refresh token (different bucket)", async () => {
    resolveMock.mockResolvedValueOnce(acct("perso", "perso@x.com", "rt-perso"));
    await handleGmailInbox({ account: "perso" });
    const oauthCall = fetchSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("oauth2.googleapis.com")
    );
    expect(refreshTokenOf(oauthCall!)).toBe("rt-perso");
  });

  it("≥2 accounts, no account arg → error envelope listing names (no throw)", async () => {
    resolveMock.mockResolvedValueOnce({
      error: "error_account_required",
      available_accounts: ["work@x.com", "perso@x.com"],
    } as AccountResolution);
    const res = await handleGmailInbox({});
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/Multiple Google accounts/);
    expect(text).toContain("work@x.com");
    expect(text).toContain("perso@x.com");
    // No OAuth exchange happened — we short-circuited before hitting Google.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no account configured → not-configured envelope", async () => {
    resolveMock.mockResolvedValueOnce({ error: "error_no_account" } as AccountResolution);
    const res = await handleGmailInbox({});
    expect(res.content[0]!.text as string).toMatch(/not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
