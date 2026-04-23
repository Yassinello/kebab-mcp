/**
 * Phase 53 — integration coverage for 5 /api/admin/metrics/* routes.
 *
 * Follows the Phase 52 admin-devices pattern: mock KV + config-facade +
 * request-context + auth at the module boundary so we exercise the
 * actual route handlers through withAdminAuth without spinning a real
 * Next server. Named under tests/integration/ per PLAN.md but runs
 * under the integration vitest config (fileParallelism: false) which
 * gives us per-file isolation for the vi.mock / vi.hoisted scaffolding.
 *
 * Scenarios (per PLAN.md decisions):
 *   - 401 on unauthed for every route
 *   - /requests happy-path: 24 buckets returned from seeded ring buffer
 *   - /requests fallback: empty buffer -> durable source tag
 *   - /latency: top-N returned sorted
 *   - /errors: connector matrix per 24h window
 *   - /ratelimit: seeded KV buckets parse + mask tenantId
 *   - /kv-quota: no Upstash creds -> source:"unknown"
 *   - /kv-quota: with creds -> source:"upstash" + percentage clamped
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted scaffolding shared across all vi.mock factories.
const { kvStore, envVars, state } = vi.hoisted(() => ({
  kvStore: new Map<string, string>(),
  envVars: {} as Record<string, string>,
  state: { allowAdmin: true, currentTenantId: null as string | null },
}));

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
    mget: async (keys: string[]) => keys.map((k) => kvStore.get(k) ?? null),
    incr: async (k: string) => {
      const cur = parseInt(kvStore.get(k) ?? "0", 10) || 0;
      const next = cur + 1;
      kvStore.set(k, String(next));
      return next;
    },
  };
  return {
    getContextKVStore: () => kv,
    getCurrentTenantId: () => state.currentTenantId,
    requestContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
    getCredential: (envKey: string) => envVars[envKey] ?? process.env[envKey],
    runWithCredentials: <T>(_creds: Record<string, string>, fn: () => T) => fn(),
  };
});

vi.mock("@/core/kv-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/kv-store")>();
  const kv = {
    kind: "filesystem" as const,
    get: async (k: string) => kvStore.get(k) ?? null,
    set: async (k: string, v: string) => {
      kvStore.set(k, v);
    },
    delete: async (k: string) => {
      kvStore.delete(k);
    },
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
    mget: async (keys: string[]) => keys.map((k) => kvStore.get(k) ?? null),
  };
  return {
    ...actual,
    getKVStore: () => kv,
  };
});

vi.mock("@/core/config-facade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/config-facade")>();
  return {
    ...actual,
    getConfig: (key: string) => envVars[key] ?? process.env[key],
    getConfigInt: (key: string, fallback: number) => {
      const v = envVars[key] ?? process.env[key];
      const n = v ? parseInt(v, 10) : NaN;
      return Number.isFinite(n) ? n : fallback;
    },
  };
});

vi.mock("@/core/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/auth")>();
  return {
    ...actual,
    checkAdminAuth: async () =>
      state.allowAdmin ? null : new Response("Unauthorized", { status: 401 }),
    checkCsrf: () => null,
  };
});

// Log-store mock for the metrics source fallback; the buffer path is
// exercised separately in tests/core/metrics.test.ts.
const { sinceMock } = vi.hoisted(() => ({ sinceMock: vi.fn() }));
vi.mock("@/core/log-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/log-store")>();
  return {
    ...actual,
    getLogStore: () => ({
      kind: "memory" as const,
      append: async () => {},
      recent: async () => [],
      since: async (ts: number) => sinceMock(ts),
    }),
  };
});

// Route handlers (import AFTER mocks).
import { GET as requestsGET } from "../../app/api/admin/metrics/requests/route";
import { GET as latencyGET } from "../../app/api/admin/metrics/latency/route";
import { GET as errorsGET } from "../../app/api/admin/metrics/errors/route";
import { GET as ratelimitGET } from "../../app/api/admin/metrics/ratelimit/route";
import { GET as kvQuotaGET } from "../../app/api/admin/metrics/kv-quota/route";
import { __resetRingBufferForTests, logToolCall } from "@/core/logging";

function makeReq(url = "http://localhost/api/admin/metrics/requests"): Request {
  return new Request(url, { method: "GET" });
}

beforeEach(() => {
  kvStore.clear();
  for (const k of Object.keys(envVars)) delete envVars[k];
  state.allowAdmin = true;
  state.currentTenantId = null;
  sinceMock.mockReset();
  sinceMock.mockResolvedValue([]);
  __resetRingBufferForTests();
});

describe("/api/admin/metrics/requests", () => {
  it("401 when unauthed", async () => {
    state.allowAdmin = false;
    const res = await requestsGET(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns 24 buckets with buffer source when ring buffer populated", async () => {
    logToolCall({
      tool: "gmail.search",
      durationMs: 50,
      status: "success",
      timestamp: new Date().toISOString(),
    });
    const res = await requestsGET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hours).toHaveLength(24);
    expect(body.source).toBe("buffer");
    expect(body.hours[0].count).toBeGreaterThanOrEqual(1);
  });

  it("falls back to durable source when buffer empty", async () => {
    sinceMock.mockResolvedValue([
      {
        ts: Date.now() - 60_000,
        level: "info",
        message: "notion.read",
        meta: {
          tool: "notion.read",
          durationMs: 75,
          status: "success",
          timestamp: new Date().toISOString(),
        },
      },
    ]);
    const res = await requestsGET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("durable");
    expect(body.hours[0].count).toBeGreaterThanOrEqual(1);
  });

  it("respects ?tool filter", async () => {
    logToolCall({
      tool: "gmail.search",
      durationMs: 50,
      status: "success",
      timestamp: new Date().toISOString(),
    });
    logToolCall({
      tool: "notion.read",
      durationMs: 50,
      status: "success",
      timestamp: new Date().toISOString(),
    });
    const res = await requestsGET(
      makeReq("http://localhost/api/admin/metrics/requests?tool=gmail.search")
    );
    const body = await res.json();
    expect(body.hours[0].count).toBe(1);
  });
});

describe("/api/admin/metrics/latency", () => {
  it("401 when unauthed", async () => {
    state.allowAdmin = false;
    const res = await latencyGET(makeReq("http://localhost/api/admin/metrics/latency"));
    expect(res.status).toBe(401);
  });

  it("returns top-N tools sorted by p95", async () => {
    for (let i = 0; i < 20; i++) {
      logToolCall({
        tool: `tool${i}`,
        durationMs: (i + 1) * 10,
        status: "success",
        timestamp: new Date().toISOString(),
      });
    }
    const res = await latencyGET(makeReq("http://localhost/api/admin/metrics/latency?limit=5"));
    const body = await res.json();
    expect(body.tools).toHaveLength(5);
    expect(body.tools[0].p95Ms).toBeGreaterThanOrEqual(body.tools[1].p95Ms);
  });
});

describe("/api/admin/metrics/errors", () => {
  it("401 when unauthed", async () => {
    state.allowAdmin = false;
    const res = await errorsGET(makeReq("http://localhost/api/admin/metrics/errors"));
    expect(res.status).toBe(401);
  });

  it("splits connector from tool and returns connector rows", async () => {
    logToolCall({
      tool: "google.calendar_list",
      durationMs: 100,
      status: "error",
      error: "boom",
      timestamp: new Date().toISOString(),
    });
    const res = await errorsGET(makeReq("http://localhost/api/admin/metrics/errors"));
    const body = await res.json();
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0].connectorId).toBe("google");
    expect(body.connectors[0].hours).toHaveLength(24);
  });
});

describe("/api/admin/metrics/ratelimit", () => {
  it("401 when unauthed", async () => {
    state.allowAdmin = false;
    const res = await ratelimitGET(makeReq("http://localhost/api/admin/metrics/ratelimit"));
    expect(res.status).toBe(401);
  });

  it("returns empty buckets when KV empty", async () => {
    const res = await ratelimitGET(makeReq("http://localhost/api/admin/metrics/ratelimit"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buckets).toEqual([]);
  });

  it("masks tenantId to first 4 chars + ellipsis", async () => {
    const windowMs = 60_000;
    const minuteBucket = Math.floor(Date.now() / windowMs);
    const key = `tenant:alphatest:ratelimit:mcp:abcdef01:${minuteBucket}`;
    kvStore.set(key, "7");
    const res = await ratelimitGET(makeReq("http://localhost/api/admin/metrics/ratelimit"));
    const body = await res.json();
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0].tenantIdMasked).toBe("alph…");
    expect(body.buckets[0].current).toBe(7);
    expect(body.buckets[0].scope).toBe("mcp");
  });

  it("leaves short tenantIds intact", async () => {
    const windowMs = 60_000;
    const minuteBucket = Math.floor(Date.now() / windowMs);
    const key = `tenant:abc:ratelimit:mcp:abcdef01:${minuteBucket}`;
    kvStore.set(key, "3");
    const res = await ratelimitGET(makeReq("http://localhost/api/admin/metrics/ratelimit"));
    const body = await res.json();
    expect(body.buckets[0].tenantIdMasked).toBe("abc");
  });
});

describe("/api/admin/metrics/kv-quota", () => {
  it("401 when unauthed", async () => {
    state.allowAdmin = false;
    const res = await kvQuotaGET(makeReq("http://localhost/api/admin/metrics/kv-quota"));
    expect(res.status).toBe(401);
  });

  it("returns source:'unknown' when Upstash creds absent", async () => {
    const res = await kvQuotaGET(makeReq("http://localhost/api/admin/metrics/kv-quota"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("unknown");
    expect(body.usedBytes).toBeNull();
    // Cache-Control header applied
    expect(res.headers.get("Cache-Control")).toContain("max-age=30");
  });

  it("returns source:'upstash' + computed percentage when creds present", async () => {
    envVars.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    envVars.UPSTASH_REDIS_REST_TOKEN = "TOKEN";
    envVars.UPSTASH_FREE_TIER_BYTES = String(1024 * 1024); // 1 MB limit for test
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: "used_memory:524288\r\nused_memory_human:512.00K\r\n" }),
    } as Response);
    try {
      const res = await kvQuotaGET(makeReq("http://localhost/api/admin/metrics/kv-quota"));
      const body = await res.json();
      expect(body.source).toBe("upstash");
      expect(body.usedBytes).toBe(524288);
      expect(body.limitBytes).toBe(1024 * 1024);
      expect(body.percentage).toBeCloseTo(50, 1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
