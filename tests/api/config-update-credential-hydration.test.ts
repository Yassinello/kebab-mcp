/**
 * Phase 062 STAB-02 — credential hydration regression test.
 *
 * Proves that hydrateCredentialsStep is wired into the /api/config/update
 * pipeline: a PAT loaded from KV by hydrateCredentialsFromKV() must be
 * visible to getCredential("KEBAB_UPDATE_PAT") inside githubApiGetHandler
 * (resolution path 1 — requestContext.credentials).
 *
 * Unlike tests/api/config-update-github.test.ts (which mocks
 * @/core/pipeline as a passthrough to test handler-level behavior), this
 * test exercises the REAL composeRequestPipeline + hydrateCredentialsStep
 * + runWithCredentials seam end-to-end. Reverting the route to
 * `withAdminAuth` (which omits hydrateCredentialsStep) makes this test
 * fail — that is the regression guard.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock the KV-credential-store so hydrate returns a known snapshot
vi.mock("@/core/credential-store", () => ({
  hydrateCredentialsFromKV: vi.fn().mockResolvedValue(undefined),
  getHydratedCredentialSnapshot: vi.fn(() => ({ KEBAB_UPDATE_PAT: "ghp_from_kv" })),
}));

// Bypass the bootstrap rehydrate — out of scope for credential resolution
vi.mock("@/core/with-bootstrap-rehydrate", () => ({
  withBootstrapRehydrate: <F extends (...args: unknown[]) => unknown>(fn: F) => fn,
}));

// Bypass admin auth — authStep would otherwise 401 the test request
vi.mock("@/core/auth", () => ({
  checkAdminAuth: vi.fn().mockResolvedValue(null),
  checkMcpAuth: vi.fn().mockReturnValue({ error: null, tokenId: "test", tenantId: null }),
}));

// Bypass the bootstrap rehydrate inside rehydrateStep
vi.mock("@/core/first-run", () => ({
  rehydrateBootstrapAsync: vi.fn().mockResolvedValue(undefined),
  isClaimer: vi.fn().mockReturnValue(false),
  getBootstrapAuthToken: vi.fn().mockReturnValue(null),
}));
vi.mock("@/core/migrations/v0.10-tenant-prefix", () => ({
  runV010TenantPrefixMigration: vi.fn().mockResolvedValue(undefined),
}));

// Mock config-facade so KEBAB_UPDATE_PAT is NOT in boot env (resolution
// path 3); only the request-scoped path can produce the token.
vi.mock("@/core/config-facade");
vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

// Phase 63 CRON-02: route now reads/writes `global:update-check` in KV.
// Mock as cache-miss + accepting writes so the live-call path runs
// — this test's contract is "Authorization header on the live compare
// call", which only fires when the cache is cold.
vi.mock("@/core/kv-store", () => ({
  getKVStore: () => ({
    kind: "filesystem" as const,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { getConfig } from "@/core/config-facade";
const mockGetConfig = vi.mocked(getConfig);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
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

describe("STAB-02: hydrateCredentialsStep wiring", () => {
  it("makes KEBAB_UPDATE_PAT from KV visible to githubApiGetHandler via runWithCredentials", async () => {
    // /repos/testowner/testslug
    fetchMock.mockResolvedValueOnce(
      mockJson({ private: false, fork: true, parent: { full_name: "Yassinello/kebab-mcp" } })
    );
    // /compare/Yassinello:kebab-mcp:main...main
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
    const res = await (mod.GET as (r: Request) => Promise<Response>)(req);
    const body = await res.json();

    // The PAT could ONLY have arrived via runWithCredentials
    // (no boot-env value, no fallback GITHUB_TOKEN).
    const compareCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/compare/")
    );
    expect(compareCall).toBeDefined();
    const headers = (compareCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_from_kv");
    expect(body.tokenConfigured).toBe(true);
  });
});
