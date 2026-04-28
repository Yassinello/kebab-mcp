import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getGoogleAccessToken, __resetGoogleTokenCacheForTests } from "../google-auth";

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
        STORE.set(k, {
          value: v,
          expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
        });
      },
      delete: async (k: string) => {
        STORE.delete(k);
      },
      list: async () => Array.from(STORE.keys()),
    }),
  };
});

describe("PERF-A-02: getGoogleAccessToken KV cache", () => {
  const origId = process.env.GOOGLE_CLIENT_ID;
  const origSecret = process.env.GOOGLE_CLIENT_SECRET;
  const origRefresh = process.env.GOOGLE_REFRESH_TOKEN;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    STORE.clear();
    __resetGoogleTokenCacheForTests();
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_REFRESH_TOKEN = "refresh-token";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ access_token: "tok-123", expires_in: 3600 }), {
          status: 200,
        })
    );
  });

  afterEach(() => {
    if (origId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = origId;
    if (origSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = origSecret;
    if (origRefresh === undefined) delete process.env.GOOGLE_REFRESH_TOKEN;
    else process.env.GOOGLE_REFRESH_TOKEN = origRefresh;
    fetchSpy.mockRestore();
  });

  it("first call hits Google OAuth and persists to KV", async () => {
    const tok = await getGoogleAccessToken();
    expect(tok).toBe("tok-123");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(STORE.has("google:oauth:access-token")).toBe(true);
  });

  it("second call (warm in-process cache) skips fetch entirely", async () => {
    await getGoogleAccessToken();
    await getGoogleAccessToken();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("cold lambda (cache reset) reads from KV instead of refetching", async () => {
    await getGoogleAccessToken();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Simulate a fresh lambda: reset the in-process cache, KV stays warm.
    __resetGoogleTokenCacheForTests();
    const tok = await getGoogleAccessToken();
    expect(tok).toBe("tok-123");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refetches when KV cache is also empty", async () => {
    await getGoogleAccessToken();
    __resetGoogleTokenCacheForTests();
    STORE.clear();
    await getGoogleAccessToken();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
