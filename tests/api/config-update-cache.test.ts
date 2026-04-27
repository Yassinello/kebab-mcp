/**
 * Phase 063 CRON-02 — cache-first GET handler tests.
 *
 * Covers:
 *   1. Fresh KV hit → returns cached payload, no fetch.
 *   2. Cache miss → calls computeUpdateStatus, writes result back to KV
 *      with 48h TTL.
 *   3. ?force=1 → bypasses KV read, always calls live + writes back.
 *   4. KV read throws → non-fatal, falls through to live call.
 *   5. Stale checkedAt (>48h old) → treated as cache miss, refetches.
 *
 * Same mock graph as tests/api/config-update-credential-hydration.test.ts
 * (proven to work end-to-end with the real composeRequestPipeline +
 * hydrateCredentialsStep), PLUS a vi.mock for @/core/kv-store so we can
 * control KV behavior precisely.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Same mock graph as config-update-credential-hydration.test.ts:
vi.mock("@/core/credential-store", () => ({
  hydrateCredentialsFromKV: vi.fn().mockResolvedValue(undefined),
  getHydratedCredentialSnapshot: vi.fn(() => ({ KEBAB_UPDATE_PAT: "ghp_test" })),
}));
vi.mock("@/core/with-bootstrap-rehydrate", () => ({
  withBootstrapRehydrate: <F extends (...args: unknown[]) => unknown>(fn: F) => fn,
}));
vi.mock("@/core/auth", () => ({
  checkAdminAuth: vi.fn().mockResolvedValue(null),
  checkMcpAuth: vi.fn().mockReturnValue({ error: null, tokenId: "test", tenantId: null }),
}));
vi.mock("@/core/first-run", () => ({
  rehydrateBootstrapAsync: vi.fn().mockResolvedValue(undefined),
  isClaimer: vi.fn().mockReturnValue(false),
  getBootstrapAuthToken: vi.fn().mockReturnValue(null),
}));
vi.mock("@/core/migrations/v0.10-tenant-prefix", () => ({
  runV010TenantPrefixMigration: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/core/config-facade");
vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

// KV mock — the seam under test
const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock("@/core/kv-store", () => ({
  getKVStore: () => ({ kind: "filesystem" as const, get: kvGet, set: kvSet }),
}));

import { getConfig } from "@/core/config-facade";
const mockGetConfig = vi.mocked(getConfig);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  kvGet.mockReset();
  kvSet.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mockGetConfig.mockImplementation((key: string) => {
    const cfg: Record<string, string> = {
      VERCEL: "1",
      VERCEL_GIT_REPO_OWNER: "testowner",
      VERCEL_GIT_REPO_SLUG: "testslug",
    };
    return cfg[key] ?? undefined;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CRON-02: cache-first GET", () => {
  it("returns cached payload without calling fetch when KV has fresh entry", async () => {
    const fresh = {
      checkedAt: new Date().toISOString(),
      mode: "github-api",
      available: true,
      behind_by: 3,
      ahead_by: 0,
      status: "behind",
      breaking: false,
      breakingReasons: [],
      commits: [],
      totalCommits: 3,
      diffUrl: "u",
      tokenConfigured: true,
      forkPrivate: false,
    };
    kvGet.mockResolvedValueOnce(JSON.stringify(fresh));
    const mod = await import("../../app/api/config/update/route");
    const req = new Request("http://localhost/api/config/update", { method: "GET" });
    const res = await (mod.GET as (r: Request) => Promise<Response>)(req);
    const body = await res.json();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.behind_by).toBe(3);
    expect(body.status).toBe("behind");
    // Cache hit MUST NOT trigger a write-back.
    expect(kvSet).not.toHaveBeenCalled();
  });

  it("calls fetch and writes KV when cache is empty", async () => {
    kvGet.mockResolvedValueOnce(null);
    kvSet.mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(
      mockJson({ private: false, fork: true, parent: { full_name: "Yassinello/kebab-mcp" } })
    );
    fetchMock.mockResolvedValueOnce(
      mockJson({
        status: "behind",
        behind_by: 1,
        ahead_by: 0,
        total_commits: 1,
        commits: [],
        html_url: "u",
      })
    );
    const mod = await import("../../app/api/config/update/route");
    const req = new Request("http://localhost/api/config/update", { method: "GET" });
    await (mod.GET as (r: Request) => Promise<Response>)(req);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(kvSet).toHaveBeenCalledWith("global:update-check", expect.any(String), 48 * 60 * 60);
  });

  it("bypasses cache when ?force=1 is set", async () => {
    kvSet.mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(
      mockJson({ private: false, fork: true, parent: { full_name: "Yassinello/kebab-mcp" } })
    );
    fetchMock.mockResolvedValueOnce(
      mockJson({
        status: "behind",
        behind_by: 5,
        ahead_by: 0,
        total_commits: 5,
        commits: [],
        html_url: "u",
      })
    );
    const mod = await import("../../app/api/config/update/route");
    const req = new Request("http://localhost/api/config/update?force=1", { method: "GET" });
    const res = await (mod.GET as (r: Request) => Promise<Response>)(req);
    const body = await res.json();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body.behind_by).toBe(5);
    expect(kvGet).not.toHaveBeenCalled(); // force=1 skips KV read entirely
    expect(kvSet).toHaveBeenCalled();
  });

  it("falls through to live call when KV read throws", async () => {
    kvGet.mockRejectedValueOnce(new Error("KV unreachable"));
    kvSet.mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(
      mockJson({ private: false, fork: true, parent: { full_name: "Yassinello/kebab-mcp" } })
    );
    fetchMock.mockResolvedValueOnce(
      mockJson({
        status: "identical",
        behind_by: 0,
        ahead_by: 0,
        total_commits: 0,
        commits: [],
        html_url: "u",
      })
    );
    const mod = await import("../../app/api/config/update/route");
    const req = new Request("http://localhost/api/config/update", { method: "GET" });
    const res = await (mod.GET as (r: Request) => Promise<Response>)(req);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats stale cache (>48h checkedAt) as cache miss", async () => {
    const stale = {
      checkedAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
      mode: "github-api",
      available: false,
      behind_by: 0,
      ahead_by: 0,
      status: "identical",
      breaking: false,
      breakingReasons: [],
      commits: [],
      totalCommits: 0,
      diffUrl: "u",
      tokenConfigured: true,
      forkPrivate: false,
    };
    kvGet.mockResolvedValueOnce(JSON.stringify(stale));
    kvSet.mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(
      mockJson({ private: false, fork: true, parent: { full_name: "Yassinello/kebab-mcp" } })
    );
    fetchMock.mockResolvedValueOnce(
      mockJson({
        status: "behind",
        behind_by: 2,
        ahead_by: 0,
        total_commits: 2,
        commits: [],
        html_url: "u",
      })
    );
    const mod = await import("../../app/api/config/update/route");
    const req = new Request("http://localhost/api/config/update", { method: "GET" });
    await (mod.GET as (r: Request) => Promise<Response>)(req);
    expect(fetchMock).toHaveBeenCalledTimes(2); // fell through to live
  });
});
