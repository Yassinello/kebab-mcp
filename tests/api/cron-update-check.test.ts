/**
 * Phase 063 CRON-01 — cron handler unit tests.
 *
 * Auth + rate-limit pipeline steps are covered by tests/contract/auth-step.test.ts
 * and the cron-health tests. This file exercises only the handler body
 * via a passthrough composeRequestPipeline mock.
 *
 * Covers:
 *   1. no-token  — KEBAB_UPDATE_PAT and GITHUB_TOKEN both absent → 200, no KV write.
 *   2. not-a-fork — VERCEL_GIT_REPO_OWNER/SLUG missing → 200, no KV write.
 *   3. success   — computeUpdateStatus returns ok → KV write is awaited with 48h TTL.
 *   4. auth-fail — computeUpdateStatus returns { ok: false, kind: "auth" } → no KV write
 *                  (don't poison the cache with auth failures).
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Pipeline passthrough: composeRequestPipeline becomes (steps, handler) => (req) => handler({ request: req, ... }).
// Steps are NOT executed — auth/rate-limit/credential-hydration are covered elsewhere.
vi.mock("@/core/pipeline", async () => {
  const actual = await vi.importActual<typeof import("@/core/pipeline")>("@/core/pipeline");
  return {
    ...actual,
    composeRequestPipeline:
      (_steps: unknown, handler: (ctx: { request: Request }) => Promise<Response>) =>
      (request: Request) =>
        handler({ request }),
    rehydrateStep: {} as never,
    authStep: () => ({}) as never,
    rateLimitStep: () => ({}) as never,
    hydrateCredentialsStep: {} as never,
  };
});

// Same mock graph as config-update-credential-hydration.test.ts:
vi.mock("@/core/credential-store", () => ({
  hydrateCredentialsFromKV: vi.fn().mockResolvedValue(undefined),
  getHydratedCredentialSnapshot: vi.fn(() => ({})),
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

// KV mock — under test
const kvSet = vi.fn();
const kvGet = vi.fn();
const kvDelete = vi.fn();
const kvSetIfNotExists = vi.fn();
vi.mock("@/core/kv-store", () => ({
  getKVStore: () => ({
    kind: "filesystem" as const,
    get: kvGet,
    set: kvSet,
    delete: kvDelete,
    setIfNotExists: kvSetIfNotExists,
  }),
}));

import { getConfig } from "@/core/config-facade";
const mockGetConfig = vi.mocked(getConfig);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  kvSet.mockReset();
  kvGet.mockReset();
  kvDelete.mockReset();
  kvDelete.mockResolvedValue(undefined);
  kvSetIfNotExists.mockReset();
  kvSetIfNotExists.mockResolvedValue({ ok: true });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setEnv(extra: Record<string, string | undefined> = {}): void {
  const cfg: Record<string, string | undefined> = {
    VERCEL: "1",
    VERCEL_GIT_REPO_OWNER: "testowner",
    VERCEL_GIT_REPO_SLUG: "testslug",
    KEBAB_UPDATE_PAT: "ghp_envtoken",
    ...extra,
  };
  mockGetConfig.mockImplementation((key: string) => cfg[key]);
}

function req(): Request {
  // No Authorization header needed — pipeline mock skips authStep.
  return new Request("http://localhost/api/cron/update-check", { method: "GET" });
}

describe("CRON-01: /api/cron/update-check handler body", () => {
  it("returns no-token when KEBAB_UPDATE_PAT and GITHUB_TOKEN are absent", async () => {
    setEnv({ KEBAB_UPDATE_PAT: undefined, GITHUB_TOKEN: undefined });
    const mod = await import("../../app/api/cron/update-check/route");
    const res = await (mod.GET as (r: Request) => Promise<Response>)(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no-token");
    expect(kvSet).not.toHaveBeenCalled();
  });

  it("returns not-a-fork when VERCEL_GIT_REPO_OWNER/SLUG are absent", async () => {
    setEnv({ VERCEL_GIT_REPO_OWNER: undefined, VERCEL_GIT_REPO_SLUG: undefined });
    const mod = await import("../../app/api/cron/update-check/route");
    const res = await (mod.GET as (r: Request) => Promise<Response>)(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not-a-fork");
    expect(kvSet).not.toHaveBeenCalled();
  });

  it("calls computeUpdateStatus and writes KV on success", async () => {
    setEnv();
    // /repos lookup
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          private: false,
          fork: true,
          parent: { full_name: "Yassinello/kebab-mcp" },
        })
      )
    );
    // /compare lookup
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "behind",
          behind_by: 4,
          ahead_by: 0,
          total_commits: 4,
          commits: [],
          html_url: "https://github.com/testowner/testslug/compare/x...y",
        })
      )
    );
    kvSet.mockResolvedValueOnce(undefined);
    const mod = await import("../../app/api/cron/update-check/route");
    const res = await (mod.GET as (r: Request) => Promise<Response>)(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.payload.behind_by).toBe(4);
    expect(kvSet).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = kvSet.mock.calls[0]!;
    expect(key).toBe("global:update-check");
    expect(ttl).toBe(48 * 60 * 60);
    const persisted = JSON.parse(value as string);
    expect(persisted.behind_by).toBe(4);
    expect(persisted.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does NOT write KV when computeUpdateStatus returns auth failure", async () => {
    setEnv();
    // /repos lookup → 401
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })
    );
    const mod = await import("../../app/api/cron/update-check/route");
    const res = await (mod.GET as (r: Request) => Promise<Response>)(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("auth");
    expect(kvSet).not.toHaveBeenCalled();
  });
});
