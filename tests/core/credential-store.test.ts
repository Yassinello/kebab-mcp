/**
 * SEC-02 regression tests for credential-store.ts.
 *
 * The key behaviors:
 *  1. saveCredentialsToKV no longer mutates process.env. Concurrent
 *     requests cannot observe each other's credential writes via
 *     process.env.
 *  2. hydrateCredentialsFromKV populates the module-scope snapshot
 *     rather than process.env, and values flow through getCredential()
 *     inside a request context.
 *  3. runWithCredentials scopes credential overrides to the callback;
 *     outside the context, getCredential() falls back to the boot
 *     snapshot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { requestContext, getCredential, runWithCredentials } from "@/core/request-context";
import {
  saveCredentialsToKV,
  hydrateCredentialsFromKV,
  getHydratedCredentialSnapshot,
  resetHydrationFlag,
} from "@/core/credential-store";
import * as kvStore from "@/core/kv-store";

function makeStubKv() {
  const store = new Map<string, string>();
  return {
    kind: "upstash" as const,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    list: vi.fn(async (prefix?: string) =>
      Array.from(store.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true))
    ),
    mget: vi.fn(async (keys: string[]) => keys.map((k) => store.get(k) ?? null)),
    scan: vi.fn(async (_cursor: string, opts?: { match?: string; count?: number }) => {
      const allKeys = Array.from(store.keys());
      const match = opts?.match;
      const filtered = match?.endsWith("*")
        ? allKeys.filter((k) => k.startsWith(match.slice(0, -1)))
        : allKeys;
      return { cursor: "0", keys: filtered };
    }),
    _store: store,
  };
}

describe("credential-store SEC-02", () => {
  let stubKv: ReturnType<typeof makeStubKv>;
  let kvSpy: ReturnType<typeof vi.spyOn>;
  let tenantKvSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stubKv = makeStubKv();
    kvSpy = vi
      .spyOn(kvStore, "getKVStore")
      .mockReturnValue(stubKv as unknown as ReturnType<typeof kvStore.getKVStore>);
    // credential-store now uses getContextKVStore → getTenantKVStore(null).
    // Stub getTenantKVStore to return our stub too.
    tenantKvSpy = vi
      .spyOn(kvStore, "getTenantKVStore")
      .mockReturnValue(stubKv as unknown as ReturnType<typeof kvStore.getTenantKVStore>);
    resetHydrationFlag();
  });

  afterEach(() => {
    kvSpy.mockRestore();
    tenantKvSpy.mockRestore();
    resetHydrationFlag();
  });

  it("saveCredentialsToKV no longer mutates process.env (SEC-02)", async () => {
    const originalSlack = process.env.SLACK_BOT_TOKEN;
    try {
      delete process.env.SLACK_BOT_TOKEN;
      await saveCredentialsToKV({ SLACK_BOT_TOKEN: "xoxb-secret-abc" });
      expect(process.env.SLACK_BOT_TOKEN).toBeUndefined();
      // But the hydrated snapshot has it (for immediate warm-lambda use).
      expect(getHydratedCredentialSnapshot().SLACK_BOT_TOKEN).toBe("xoxb-secret-abc");
      // And it lives in KV for cold-start hydrate.
      expect(stubKv._store.get("cred:SLACK_BOT_TOKEN")).toBe("xoxb-secret-abc");
    } finally {
      if (originalSlack === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = originalSlack;
    }
  });

  it("hydrateCredentialsFromKV populates the snapshot, not process.env", async () => {
    const originalGithub = process.env.GITHUB_TOKEN;
    try {
      delete process.env.GITHUB_TOKEN;
      stubKv._store.set("cred:GITHUB_TOKEN", "ghp-secret-xyz");
      await hydrateCredentialsFromKV();
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
      expect(getHydratedCredentialSnapshot().GITHUB_TOKEN).toBe("ghp-secret-xyz");
    } finally {
      if (originalGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGithub;
    }
  });

  it("runWithCredentials scopes credentials to the callback (SEC-02)", async () => {
    // Outside any context, getCredential falls back to boot env.
    expect(getCredential("SLACK_BOT_TOKEN_SEC02_TEST")).toBeUndefined();

    await runWithCredentials({ SLACK_BOT_TOKEN_SEC02_TEST: "scoped-alpha-token" }, async () => {
      expect(getCredential("SLACK_BOT_TOKEN_SEC02_TEST")).toBe("scoped-alpha-token");
    });

    // After the callback, the override is gone.
    expect(getCredential("SLACK_BOT_TOKEN_SEC02_TEST")).toBeUndefined();
  });

  it("concurrent requests see their own credentials via runWithCredentials (SEC-02)", async () => {
    // Simulate two concurrent tenant requests with different creds.
    const observedAlpha: string[] = [];
    const observedBeta: string[] = [];

    await Promise.all([
      runWithCredentials({ SLACK_BOT_TOKEN_SEC02_TEST: "alpha-tkn" }, async () => {
        // Yield to the event loop to let beta interleave.
        await new Promise((r) => setImmediate(r));
        observedAlpha.push(getCredential("SLACK_BOT_TOKEN_SEC02_TEST") ?? "MISSING");
      }),
      runWithCredentials({ SLACK_BOT_TOKEN_SEC02_TEST: "beta-tkn" }, async () => {
        await new Promise((r) => setImmediate(r));
        observedBeta.push(getCredential("SLACK_BOT_TOKEN_SEC02_TEST") ?? "MISSING");
      }),
    ]);

    // Each request saw its own credential — no cross-contamination.
    expect(observedAlpha).toEqual(["alpha-tkn"]);
    expect(observedBeta).toEqual(["beta-tkn"]);
    // process.env was not touched at any point.
    expect(process.env.SLACK_BOT_TOKEN_SEC02_TEST).toBeUndefined();
  });

  it("getCredential falls back to boot snapshot when no request context is active", async () => {
    // NODE_ENV is in RUNTIME_READ_THROUGH so it tracks live process.env.
    expect(getCredential("NODE_ENV")).toBe(process.env.NODE_ENV);
  });

  it("runWithCredentials override wins over RUNTIME_READ_THROUGH env", async () => {
    // VERCEL_GIT_COMMIT_SHA is RUNTIME_READ_THROUGH, but the override
    // still takes priority when present.
    await runWithCredentials({ VERCEL_GIT_COMMIT_SHA: "override-sha" }, async () => {
      expect(getCredential("VERCEL_GIT_COMMIT_SHA")).toBe("override-sha");
    });
  });

  it("inside an active requestContext.run, runWithCredentials preserves tenantId", async () => {
    await requestContext.run({ tenantId: "tenant-gamma" }, async () => {
      await runWithCredentials({ FOO: "bar" }, async () => {
        expect(getCredential("FOO")).toBe("bar");
        // tenantId propagates through
        const store = requestContext.getStore();
        expect(store?.tenantId).toBe("tenant-gamma");
      });
    });
  });
});
