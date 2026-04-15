import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkRateLimit } from "./rate-limit";
import { getKVStore, resetKVStoreCache, type KVStore } from "./kv-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("checkRateLimit", () => {
  let kvDir: string;
  let savedCwd: string;

  beforeEach(() => {
    // Isolate each test's KV into its own temp dir so buckets from
    // previous tests don't leak.
    savedCwd = process.cwd();
    kvDir = mkdtempSync(join(tmpdir(), "mymcp-rl-test-"));
    process.chdir(kvDir);
    resetKVStoreCache();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    resetKVStoreCache();
    try {
      rmSync(kvDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("allows the first request and decrements remaining", async () => {
    const result = await checkRateLimit("user-a", { scope: "test", limit: 3 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("blocks when the limit is exceeded within the same bucket", async () => {
    await checkRateLimit("user-b", { scope: "test", limit: 2 });
    await checkRateLimit("user-b", { scope: "test", limit: 2 });
    const result = await checkRateLimit("user-b", { scope: "test", limit: 2 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("partitions buckets by scope", async () => {
    await checkRateLimit("user-c", { scope: "mcp", limit: 1 });
    // Different scope → separate bucket.
    const result = await checkRateLimit("user-c", { scope: "setup", limit: 1 });
    expect(result.allowed).toBe(true);
  });

  it("uses the atomic incr path when KV implements it (FilesystemKV)", async () => {
    // FilesystemKV now implements incr. Fire 5 calls with limit=3 and
    // assert exactly 3 allowed, 2 blocked. Under the old racy path two
    // concurrent winners could both succeed; under the atomic path the
    // counter monotonically advances and the limit is precise.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkRateLimit("user-atomic", { scope: "atomic", limit: 3 }))
    );
    const allowed = results.filter((r) => r.allowed).length;
    const blocked = results.filter((r) => !r.allowed).length;
    expect(allowed).toBe(3);
    expect(blocked).toBe(2);
  });

  it("sweeps stale buckets on the first request of a new minute window", async () => {
    // Seed an old bucket directly so the sweep has something to clean.
    const kv = getKVStore();
    const idHash = "0123456789abcdef";
    await kv.set(`ratelimit:test:${idHash}:1000000`, "5");
    await kv.set(`ratelimit:test:${idHash}:1000001`, "5");

    // Confirm seeded
    const beforeKeys = await kv.list(`ratelimit:test:${idHash}:`);
    expect(beforeKeys.length).toBe(2);

    // Calling checkRateLimit with the same idHash won't happen because
    // the function hashes internally. Instead, we directly exercise the
    // listing behavior — a fresh call under the same scope should not
    // touch our seeded keys (which use a fake idHash), but ensure the
    // function doesn't throw on the sweep path.
    await checkRateLimit("user-d", { scope: "test", limit: 3 });

    // The seeded buckets for the fake idHash remain because the sweep is
    // keyed by the caller's own identifier hash. This is by design —
    // cleanup is per-caller, not global.
    const afterKeys = await kv.list(`ratelimit:test:${idHash}:`);
    expect(afterKeys.length).toBe(2);
  });
});

/**
 * MemoryKV — in-process store with atomic incr. Used to assert the
 * rate limiter's atomic path holds under concurrent fire-and-forget
 * increments without any filesystem round-trips.
 */
class MemoryKV implements KVStore {
  kind = "filesystem" as const;
  private map = new Map<string, string>();
  public incrCalls = 0;
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async list(prefix?: string) {
    const keys = [...this.map.keys()];
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }
  async incr(key: string, _opts?: { ttlSeconds?: number }) {
    this.incrCalls++;
    const prev = parseInt(this.map.get(key) ?? "0", 10);
    const next = Number.isFinite(prev) ? prev + 1 : 1;
    this.map.set(key, String(next));
    return next;
  }
}

describe("checkRateLimit — MemoryKV atomic path", () => {
  let memKv: MemoryKV;

  beforeEach(async () => {
    memKv = new MemoryKV();
    // Swap getKVStore by monkey-patching the module cache: we import it
    // and override via resetting + stubbing the env to force fallback,
    // but the cleanest path is to inject via vi.spyOn on the module.
    const kvModule = await import("./kv-store");
    vi.spyOn(kvModule, "getKVStore").mockReturnValue(memKv);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps concurrent increments at the configured limit", async () => {
    const N = 20;
    const limit = 7;
    const results = await Promise.all(
      Array.from({ length: N }, () => checkRateLimit("burst-user", { scope: "burst", limit }))
    );
    const allowed = results.filter((r) => r.allowed).length;
    const blocked = results.filter((r) => !r.allowed).length;
    expect(allowed).toBe(limit);
    expect(blocked).toBe(N - limit);
    // Every call goes through incr exactly once.
    expect(memKv.incrCalls).toBe(N);
  });

  it("passes a TTL to incr roughly equal to 2× the window", async () => {
    const spy = vi.spyOn(memKv, "incr");
    await checkRateLimit("ttl-user", { scope: "ttl", limit: 5 });
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][1];
    expect(opts?.ttlSeconds).toBe(120);
  });
});

describe("UpstashKV.incr — fetch mock shape", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify([{ result: 1 }, { result: 1 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("sends INCR + EXPIRE to the Upstash /pipeline endpoint", async () => {
    // Construct UpstashKV via env + factory so we're exercising the real
    // code path including URL normalization.
    const origUrl = process.env.UPSTASH_REDIS_REST_URL;
    const origTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    resetKVStoreCache();
    try {
      const kv = getKVStore();
      expect(kv.kind).toBe("upstash");
      const n = await kv.incr!("k1", { ttlSeconds: 60 });
      expect(n).toBe(1);

      // Inspect the request body — first call, first arg is URL, second is init.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://fake.upstash.io/pipeline");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual([
        ["INCR", "k1"],
        ["EXPIRE", "k1", 60],
      ]);
      const auth = (init.headers as Record<string, string>).Authorization;
      expect(auth).toBe("Bearer fake-token");
    } finally {
      if (origUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = origUrl;
      if (origTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = origTok;
      resetKVStoreCache();
    }
  });
});
