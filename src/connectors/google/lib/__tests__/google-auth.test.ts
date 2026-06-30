import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getGoogleAccessToken,
  evictGoogleTokenCache,
  __resetGoogleTokenCacheForTests,
  type GoogleAuthContext,
} from "../google-auth";

const STORE = new Map<string, { value: string; expiresAt?: number }>();

vi.mock("@/core/request-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/request-context")>();
  return {
    ...actual,
    getContextKVStore: () => ({
      get: async (k: string) => {
        const e = STORE.get(k);
        if (!e) return null;
        if (e.expiresAt && Date.now() > e.expiresAt) {
          STORE.delete(k);
          return null;
        }
        return e.value;
      },
      set: async (k: string, v: string, ttl?: number) => {
        const entry: { value: string; expiresAt?: number } = { value: v };
        if (ttl) entry.expiresAt = Date.now() + ttl * 1000;
        STORE.set(k, entry);
      },
      delete: async (k: string) => {
        STORE.delete(k);
      },
      list: async () => Array.from(STORE.keys()),
    }),
  };
});

/** Build a per-account auth context. Different slugs → different cache buckets. */
function ctxFor(slug: string, refresh = `rt-${slug}`): GoogleAuthContext {
  return {
    slug,
    tokens: {
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: refresh,
    },
  };
}

describe("PERF-A-02 + v0.19: getGoogleAccessToken per-account cache", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let minted = 0;

  beforeEach(() => {
    STORE.clear();
    __resetGoogleTokenCacheForTests();
    minted = 0;
    // Each OAuth exchange mints a distinct access token, so we can prove which
    // account's token a call returns.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ access_token: `tok-${++minted}`, expires_in: 3600 }), {
          status: 200,
        })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("first call hits Google OAuth and persists to a slug-scoped KV key", async () => {
    const tok = await getGoogleAccessToken(ctxFor("default"));
    expect(tok).toBe("tok-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(STORE.has("google:oauth:access-token:default")).toBe(true);
  });

  it("second call (warm in-process cache) skips fetch entirely", async () => {
    await getGoogleAccessToken(ctxFor("default"));
    await getGoogleAccessToken(ctxFor("default"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("cold lambda (cache reset) reads from KV instead of refetching", async () => {
    await getGoogleAccessToken(ctxFor("default"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Simulate a fresh lambda: reset the in-process cache, KV stays warm.
    __resetGoogleTokenCacheForTests();
    const tok = await getGoogleAccessToken(ctxFor("default"));
    expect(tok).toBe("tok-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refetches when KV cache is also empty", async () => {
    await getGoogleAccessToken(ctxFor("default"));
    __resetGoogleTokenCacheForTests();
    STORE.clear();
    await getGoogleAccessToken(ctxFor("default"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("two accounts use two distinct cache buckets — no cross-contamination", async () => {
    const tokA = await getGoogleAccessToken(ctxFor("work"));
    const tokB = await getGoogleAccessToken(ctxFor("perso"));
    // Each minted its own token (two fetches, two KV keys).
    expect(tokA).toBe("tok-1");
    expect(tokB).toBe("tok-2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(STORE.has("google:oauth:access-token:work")).toBe(true);
    expect(STORE.has("google:oauth:access-token:perso")).toBe(true);
    // Re-reading each is a warm hit on its own bucket — still 2 fetches total.
    expect(await getGoogleAccessToken(ctxFor("work"))).toBe("tok-1");
    expect(await getGoogleAccessToken(ctxFor("perso"))).toBe("tok-2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("evictGoogleTokenCache drops only the named account's buckets", async () => {
    await getGoogleAccessToken(ctxFor("work"));
    await getGoogleAccessToken(ctxFor("perso"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await evictGoogleTokenCache("work");
    // work's L1 + L2 are gone → a re-read refetches (mints tok-3).
    expect(STORE.has("google:oauth:access-token:work")).toBe(false);
    expect(await getGoogleAccessToken(ctxFor("work"))).toBe("tok-3");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // perso untouched → still a warm hit, no new fetch.
    expect(await getGoogleAccessToken(ctxFor("perso"))).toBe("tok-2");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("missing refresh token throws a configuration error naming the account", async () => {
    const bad: GoogleAuthContext = {
      slug: "broken",
      tokens: { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" },
    };
    await expect(getGoogleAccessToken(bad)).rejects.toThrow(/broken/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
