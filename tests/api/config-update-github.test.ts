/**
 * Phase 061 Plan 03 — Unit tests for github-api mode in /api/config/update
 *
 * 6 test cases covering the documented GET and POST scenarios from the
 * technical spec. Mocks withAdminAuth, global fetch, getCredential, and
 * getConfig so no real network or git CLI is invoked.
 *
 * Follows the Vitest + vi.mock pattern from tests/api/config-logs-route.test.ts.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ── Mock declarations (hoisted before imports) ──────────────────────────

vi.mock("@/core/with-admin-auth", () => ({
  withAdminAuth: <F extends (...args: unknown[]) => unknown>(fn: F) => fn,
}));

// Phase 62 STAB-02: route now uses an explicit pipeline (composeRequestPipeline)
// instead of withAdminAuth. Bypass the real authStep("admin") so the existing
// 6 unit tests continue to invoke the handler directly without auth.
vi.mock("@/core/pipeline", async () => {
  const actual = await vi.importActual<typeof import("@/core/pipeline")>("@/core/pipeline");
  return {
    ...actual,
    // Make composeRequestPipeline a passthrough — call handler directly.
    composeRequestPipeline: <H>(_steps: unknown[], handler: H) => handler,
  };
});

vi.mock("@/core/with-bootstrap-rehydrate", () => ({
  withBootstrapRehydrate: <F extends (...args: unknown[]) => unknown>(fn: F) => fn,
}));

vi.mock("@/core/config-facade");
vi.mock("@/core/request-context");
vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

// Phase 63 CRON-02: route now reads/writes `global:update-check` in KV.
// Mock as cache-miss + accepting writes so the live-call path runs as
// before — the existing assertions don't care about KV interactions.
vi.mock("@/core/kv-store", () => ({
  getKVStore: () => ({
    kind: "filesystem" as const,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ── Dynamic imports (after mocks) ──────────────────────────────────────

import { getConfig } from "@/core/config-facade";
import { getCredential } from "@/core/request-context";

const mockGetConfig = vi.mocked(getConfig);
const mockGetCredential = vi.mocked(getCredential);

// ── Fetch mock infrastructure ──────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mockGetConfig.mockReset();
  mockGetCredential.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Helpers ────────────────────────────────────────────────────────────

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }) as Response;
}

/**
 * Wire getConfig to simulate Vercel deployment with a real owner+slug.
 */
function setupVercelEnv(
  owner = "testowner",
  slug = "testslug",
  extra: Record<string, string> = {}
): void {
  mockGetConfig.mockImplementation((key: string) => {
    const cfg: Record<string, string> = {
      VERCEL: "1",
      VERCEL_GIT_REPO_OWNER: owner,
      VERCEL_GIT_REPO_SLUG: slug,
      ...extra,
    };
    return cfg[key] ?? undefined;
  });
}

/**
 * Wire getCredential to return a PAT for KEBAB_UPDATE_PAT.
 */
function setupPat(token = "ghp_test"): void {
  mockGetCredential.mockImplementation((key: string) => {
    if (key === "KEBAB_UPDATE_PAT") return token;
    return undefined;
  });
}

// ── Test Suite ─────────────────────────────────────────────────────────

describe("github-api mode", () => {
  // ── Case 1: GET — behind_by > 0, update available ───────────────────

  it("Case 1: GET returns available=true with behind_by, commits, breaking=false", async () => {
    setupVercelEnv("testowner", "testslug");
    setupPat("ghp_test");

    // /repos/testowner/testslug — fork visibility
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        private: false,
        fork: true,
        parent: { full_name: "Yassinello/kebab-mcp" },
      })
    );

    // /repos/testowner/testslug/compare/main...Yassinello:kebab-mcp:main
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        status: "behind",
        behind_by: 3,
        ahead_by: 0,
        total_commits: 3,
        commits: [
          {
            sha: "abc1234",
            html_url: "https://github.com/c/1",
            commit: { message: "feat: add thing" },
          },
        ],
        html_url: "https://github.com/diff",
      })
    );

    const mod = await import("../../app/api/config/update/route");
    // Phase 63 CRON-02: getHandler now accepts (ctx: PipelineContext) so it
    // can read ?force=1 from ctx.request.url. composeRequestPipeline is
    // mocked as a passthrough, so mod.GET === getHandler — we feed it a
    // minimal ctx with a request URL it can parse.
    const fakeCtx = { request: new Request("http://localhost/api/config/update") };
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)(fakeCtx);
    const body = await res.json();

    expect(body.mode).toBe("github-api");
    expect(body.available).toBe(true);
    expect(body.behind_by).toBe(3);
    expect(body.ahead_by).toBe(0);
    expect(body.status).toBe("behind");
    expect(body.breaking).toBe(false);
    expect(body.tokenConfigured).toBe(true);
    expect(body.forkPrivate).toBe(false);

    // Verify Compare URL direction: BASE=upstream, HEAD=fork (D-02)
    const compareCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/compare/")
    );
    expect(compareCalls.length).toBeGreaterThan(0);
    expect(compareCalls[0]![0]).toContain("/compare/Yassinello:kebab-mcp:main...main");
    expect(compareCalls[0]![0]).not.toContain("/compare/main...Yassinello");
  });

  // ── Case 2: GET — diverged fork (ahead_by > 0) ──────────────────────

  it("Case 2: GET returns available=false when fork is diverged (ahead_by > 0)", async () => {
    setupVercelEnv("testowner", "testslug");
    setupPat("ghp_test");

    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        private: false,
        fork: true,
        parent: { full_name: "Yassinello/kebab-mcp" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        status: "diverged",
        behind_by: 2,
        ahead_by: 1,
        total_commits: 2,
        commits: [],
        html_url: "https://github.com/diff",
      })
    );

    const mod = await import("../../app/api/config/update/route");
    // Phase 63 CRON-02: getHandler now accepts (ctx: PipelineContext) so it
    // can read ?force=1 from ctx.request.url. composeRequestPipeline is
    // mocked as a passthrough, so mod.GET === getHandler — we feed it a
    // minimal ctx with a request URL it can parse.
    const fakeCtx = { request: new Request("http://localhost/api/config/update") };
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)(fakeCtx);
    const body = await res.json();

    expect(body.mode).toBe("github-api");
    expect(body.available).toBe(false);
    expect(body.ahead_by).toBe(1);
    expect(body.status).toBe("diverged");

    // Verify Compare URL direction: BASE=upstream, HEAD=fork (D-02)
    const compareCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/compare/")
    );
    expect(compareCalls.length).toBeGreaterThan(0);
    expect(compareCalls[0]![0]).toContain("/compare/Yassinello:kebab-mcp:main...main");
    expect(compareCalls[0]![0]).not.toContain("/compare/main...Yassinello");
  });

  // ── Case 3: GET — breaking commit detected ──────────────────────────

  it("Case 3: GET sets breaking=true when a commit uses conventional-bang syntax", async () => {
    setupVercelEnv("testowner", "testslug");
    setupPat("ghp_test");

    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        private: false,
        fork: true,
        parent: { full_name: "Yassinello/kebab-mcp" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        status: "behind",
        behind_by: 1,
        ahead_by: 0,
        total_commits: 1,
        commits: [
          {
            sha: "abc",
            html_url: "u",
            commit: { message: "feat!: drop legacy API" },
          },
        ],
        html_url: "https://github.com/diff",
      })
    );

    const mod = await import("../../app/api/config/update/route");
    // Phase 63 CRON-02: getHandler now accepts (ctx: PipelineContext) so it
    // can read ?force=1 from ctx.request.url. composeRequestPipeline is
    // mocked as a passthrough, so mod.GET === getHandler — we feed it a
    // minimal ctx with a request URL it can parse.
    const fakeCtx = { request: new Request("http://localhost/api/config/update") };
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)(fakeCtx);
    const body = await res.json();

    expect(body.breaking).toBe(true);
    expect(body.breakingReasons).toHaveLength(1);
    expect(body.breakingReasons[0]).toContain("feat!: drop legacy API");

    // Verify Compare URL direction: BASE=upstream, HEAD=fork (D-02)
    const compareCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/compare/")
    );
    expect(compareCalls.length).toBeGreaterThan(0);
    expect(compareCalls[0]![0]).toContain("/compare/Yassinello:kebab-mcp:main...main");
    expect(compareCalls[0]![0]).not.toContain("/compare/main...Yassinello");
  });

  // ── Case 4: GET — no token configured ───────────────────────────────

  it("Case 4: GET returns no-token shape when no PAT or GITHUB_TOKEN present", async () => {
    setupVercelEnv("testowner", "testslug");

    // All credential/config lookups return nothing
    mockGetCredential.mockReturnValue(undefined);
    mockGetConfig.mockImplementation((key: string) => {
      const cfg: Record<string, string> = {
        VERCEL: "1",
        VERCEL_GIT_REPO_OWNER: "testowner",
        VERCEL_GIT_REPO_SLUG: "testslug",
      };
      return cfg[key] ?? undefined;
    });

    const mod = await import("../../app/api/config/update/route");
    // Phase 63 CRON-02: getHandler now accepts (ctx: PipelineContext) so it
    // can read ?force=1 from ctx.request.url. composeRequestPipeline is
    // mocked as a passthrough, so mod.GET === getHandler — we feed it a
    // minimal ctx with a request URL it can parse.
    const fakeCtx = { request: new Request("http://localhost/api/config/update") };
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)(fakeCtx);
    const body = await res.json();

    expect(body.available).toBe(false);
    expect(body.reason).toBe("no-token");
    expect(body.mode).toBe("github-api");
    expect(body.tokenConfigured).toBe(false);
  });

  // ── Case 5: POST — successful merge ─────────────────────────────────

  it("Case 5: POST returns ok=true with pulled, merge_type, deployUrl on success", async () => {
    setupVercelEnv("testowner", "testslug");
    setupPat("ghp_test");

    // compare re-fetch before merge
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        ahead_by: 0,
        behind_by: 2,
        html_url: "https://github.com/diff",
      })
    );

    // merge-upstream POST
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ merge_type: "fast-forward" }));

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.POST as unknown as () => Promise<Response>)();
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.pulled).toBe(2);
    expect(body.merge_type).toBe("fast-forward");
    expect(body.deployUrl).toBe("https://vercel.com/testowner/testslug/deployments");

    // Verify Compare URL direction: BASE=upstream, HEAD=fork (D-02)
    const compareCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/compare/")
    );
    expect(compareCalls.length).toBeGreaterThan(0);
    expect(compareCalls[0]![0]).toContain("/compare/Yassinello:kebab-mcp:main...main");
    expect(compareCalls[0]![0]).not.toContain("/compare/main...Yassinello");
  });

  // ── Case 6: POST — 409 conflict from GitHub ──────────────────────────

  it("Case 6: POST returns ok=false, reason=conflict on 409 from GitHub merge-upstream", async () => {
    setupVercelEnv("testowner", "testslug");
    setupPat("ghp_test");

    // compare re-fetch
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        ahead_by: 0,
        behind_by: 1,
        html_url: "https://github.com/diff",
      })
    );

    // merge-upstream → 409
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ message: "Merge conflict" }, 409));

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.POST as unknown as () => Promise<Response>)();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("conflict");

    // Verify Compare URL direction: BASE=upstream, HEAD=fork (D-02)
    const compareCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/compare/")
    );
    expect(compareCalls.length).toBeGreaterThan(0);
    expect(compareCalls[0]![0]).toContain("/compare/Yassinello:kebab-mcp:main...main");
    expect(compareCalls[0]![0]).not.toContain("/compare/main...Yassinello");
  });

  // ── Case 7: GET — deployed repo is not a fork of upstream ──────────────
  //
  // Reproduces the kebab-mcp-yass bug (2026-04-28). Vercel's /new/clone
  // creates a standalone snapshot, NOT a real GitHub fork. The repo lookup
  // returns `fork: false, parent: null`. The route must short-circuit with
  // `reason: "not-a-fork"` instead of running the Compare API (which would
  // misleadingly return "identical" for a snapshot, telling the user
  // "everything is up to date" when in reality they will never receive
  // any update.

  it("Case 7: GET returns reason=not-a-fork when deployed repo lacks an upstream parent", async () => {
    setupVercelEnv("someone", "kebab-mcp-clone");
    setupPat("ghp_test");

    // /repos/<owner>/<slug> — the snapshot is a standalone repo.
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ private: false, fork: false, parent: null })
    );

    const mod = await import("../../app/api/config/update/route");
    const fakeCtx = { request: new Request("http://localhost/api/config/update") };
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)(fakeCtx);
    const body = await res.json();

    expect(body.mode).toBe("github-api");
    expect(body.available).toBe(false);
    expect(body.reason).toBe("not-a-fork");
    expect(body.deployedRepo).toBe("someone/kebab-mcp-clone");
    expect(body.upstreamRepo).toBe("Yassinello/kebab-mcp");
    expect(body.redeployUrl).toContain("vercel.com/new/deploy");

    // Verify the Compare API was NEVER called — the short-circuit happens
    // before the second fetch.
    const compareCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/compare/")
    );
    expect(compareCalls).toHaveLength(0);
  });

  // ── Case 8: GET — fork's parent points elsewhere ───────────────────────

  it("Case 8: GET returns reason=not-a-fork when fork.parent != upstream", async () => {
    setupVercelEnv("someone", "their-fork");
    setupPat("ghp_test");

    // Real GitHub fork, but of a DIFFERENT upstream — merge-upstream would
    // pull from the wrong place. Treat as not-a-fork from our POV.
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        private: false,
        fork: true,
        parent: { full_name: "OtherOrg/other-project" },
      })
    );

    const mod = await import("../../app/api/config/update/route");
    const fakeCtx = { request: new Request("http://localhost/api/config/update") };
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)(fakeCtx);
    const body = await res.json();

    expect(body.reason).toBe("not-a-fork");
    expect(body.deployedRepo).toBe("someone/their-fork");
  });
});
