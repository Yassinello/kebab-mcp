/**
 * Tests for github-api mode in /api/config/update route.
 *
 * Covers:
 * - resolveMode() routing logic
 * - GET github-api: no-token shape
 * - GET github-api: behind/ahead shapes
 * - GET github-api: breaking-change detection
 * - POST github-api: server-side ahead_by guard
 * - POST github-api: merge-upstream success
 * - POST github-api: conflict / auth / not-a-fork error shapes
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Config / credential mocks ──────────────────────────────────────────

vi.mock("@/core/config-facade", () => ({
  getConfig: vi.fn(),
}));

vi.mock("@/core/request-context", () => ({
  getCredential: vi.fn(),
  runWithCredentials: vi.fn((creds: Record<string, string>, fn: () => unknown) => fn()),
  requestContext: { getStore: vi.fn(() => undefined) },
}));

vi.mock("@/core/with-admin-auth", () => ({
  withAdminAuth: (fn: unknown) => fn,
}));

// Phase 62 STAB-02: route now uses an explicit pipeline (composeRequestPipeline)
// instead of withAdminAuth. Bypass the real authStep("admin") so the legacy
// 14 unit tests continue to invoke the handler directly without auth.
vi.mock("@/core/pipeline", async () => {
  const actual = await vi.importActual<typeof import("@/core/pipeline")>("@/core/pipeline");
  return {
    ...actual,
    composeRequestPipeline: <H>(_steps: unknown[], handler: H) => handler,
  };
});

vi.mock("@/core/with-bootstrap-rehydrate", () => ({
  withBootstrapRehydrate: (fn: unknown) => fn,
}));

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

import { getConfig } from "@/core/config-facade";
import { getCredential } from "@/core/request-context";

const mockGetConfig = vi.mocked(getConfig);
const mockGetCredential = vi.mocked(getCredential);

// ── Fetch mock ─────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mockGetConfig.mockReset();
  mockGetCredential.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ────────────────────────────────────────────────────────────

function makeJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h === "x-oauth-scopes" ? "repo" : null) },
    json: async () => data,
  } as unknown as Response;
}

function configForGithubApi(
  owner = "testowner",
  slug = "test-repo",
  extraConfig: Record<string, string> = {}
) {
  mockGetConfig.mockImplementation((key: string) => {
    const map: Record<string, string> = {
      VERCEL: "1",
      VERCEL_GIT_REPO_OWNER: owner,
      VERCEL_GIT_REPO_SLUG: slug,
      ...extraConfig,
    };
    return map[key] ?? undefined;
  });
}

function configForGit() {
  mockGetConfig.mockImplementation((key: string) => {
    if (key === "VERCEL") return undefined;
    return undefined;
  });
}

// ── resolveMode tests ──────────────────────────────────────────────────

describe("resolveMode()", () => {
  it("returns 'github-api' when VERCEL=1 and owner+slug are set", async () => {
    configForGithubApi();
    mockGetCredential.mockReturnValue(undefined);
    const mod = await import("../../app/api/config/update/route");
    // Use GET to indirectly test resolveMode — github-api path is triggered
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)({
      request: new Request("http://localhost/api/config/update"),
    });
    const body = await res.json();
    expect(body.mode).toBe("github-api");
  });

  it("returns 'disabled' when VERCEL=1 but owner is missing", async () => {
    mockGetConfig.mockImplementation((key: string) => {
      if (key === "VERCEL") return "1";
      return undefined; // no owner/slug
    });
    mockGetCredential.mockReturnValue(undefined);
    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)({
      request: new Request("http://localhost/api/config/update"),
    });
    const body = await res.json();
    // disabled mode returns available:false
    expect(body.available).toBe(false);
    expect(body.mode).toBeUndefined(); // git mode or disabled, not github-api
  });

  it("returns 'disabled' when KEBAB_DISABLE_UPDATE_API=1", async () => {
    mockGetConfig.mockImplementation((key: string) => {
      if (key === "KEBAB_DISABLE_UPDATE_API") return "1";
      return undefined;
    });
    mockGetCredential.mockReturnValue(undefined);
    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)({
      request: new Request("http://localhost/api/config/update"),
    });
    const body = await res.json();
    expect(body.available).toBe(false);
  });
});

// ── GET github-api: no-token ───────────────────────────────────────────

describe("GET github-api — no token", () => {
  it("returns mode=github-api, available=false, reason=no-token", async () => {
    configForGithubApi();
    mockGetCredential.mockReturnValue(undefined); // no KEBAB_UPDATE_PAT, no GITHUB_TOKEN

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)({
      request: new Request("http://localhost/api/config/update"),
    });
    const body = await res.json();

    expect(body.mode).toBe("github-api");
    expect(body.available).toBe(false);
    expect(body.reason).toBe("no-token");
    expect(body.configureUrl).toBeTruthy();
    expect(body.tokenConfigured).toBe(false);
  });
});

// ── GET github-api: behind upstream ───────────────────────────────────

describe("GET github-api — behind upstream (update available)", () => {
  it("returns available=true with behind_by, commits, breaking=false", async () => {
    configForGithubApi();
    mockGetCredential.mockImplementation((key: string) => {
      if (key === "KEBAB_UPDATE_PAT") return "ghp_testtoken";
      return undefined;
    });

    // First fetch: /repos/<owner>/<slug> — visibility
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        private: false,
        fork: true,
        parent: { full_name: "Yassinello/kebab-mcp" },
      })
    );

    // Second fetch: /repos/.../compare/...
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        status: "behind",
        ahead_by: 0,
        behind_by: 3,
        total_commits: 3,
        commits: [
          { sha: "abc1234", html_url: "https://github.com/x", commit: { message: "fix: bug" } },
          { sha: "def5678", html_url: "https://github.com/y", commit: { message: "feat: new" } },
          { sha: "ghi9012", html_url: "https://github.com/z", commit: { message: "chore: dep" } },
        ],
        html_url: "https://github.com/compare",
      })
    );

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)({
      request: new Request("http://localhost/api/config/update"),
    });
    const body = await res.json();

    expect(body.mode).toBe("github-api");
    expect(body.available).toBe(true);
    expect(body.behind_by).toBe(3);
    expect(body.ahead_by).toBe(0);
    expect(body.status).toBe("behind");
    expect(body.breaking).toBe(false);
    expect(body.breakingReasons).toHaveLength(0);
    expect(body.commits).toHaveLength(3);
    expect(body.tokenConfigured).toBe(true);
    expect(body.forkPrivate).toBe(false);
    expect(body.diffUrl).toBeTruthy();
  });
});

// ── GET github-api: ahead upstream ────────────────────────────────────

describe("GET github-api — ahead of upstream", () => {
  it("returns available=false when ahead_by > 0", async () => {
    configForGithubApi();
    mockGetCredential.mockReturnValue("ghp_testtoken");

    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        private: false,
        fork: true,
        parent: { full_name: "Yassinello/kebab-mcp" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        status: "ahead",
        ahead_by: 2,
        behind_by: 0,
        total_commits: 0,
        commits: [],
        html_url: "https://github.com/compare",
      })
    );

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)({
      request: new Request("http://localhost/api/config/update"),
    });
    const body = await res.json();

    expect(body.available).toBe(false);
    expect(body.ahead_by).toBe(2);
    expect(body.status).toBe("ahead");
  });
});

// ── GET github-api: breaking change detection ─────────────────────────

describe("GET github-api — breaking change detection", () => {
  it("detects conventional-commit bang (feat!:) as breaking", async () => {
    configForGithubApi();
    mockGetCredential.mockReturnValue("ghp_testtoken");

    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        private: false,
        fork: true,
        parent: { full_name: "Yassinello/kebab-mcp" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        status: "behind",
        ahead_by: 0,
        behind_by: 1,
        total_commits: 1,
        commits: [
          {
            sha: "abc1234",
            html_url: "https://github.com/x",
            commit: { message: "feat!: remove deprecated API\n\nThis breaks things." },
          },
        ],
        html_url: "https://github.com/compare",
      })
    );

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)({
      request: new Request("http://localhost/api/config/update"),
    });
    const body = await res.json();

    expect(body.breaking).toBe(true);
    expect(body.breakingReasons).toHaveLength(1);
    expect(body.breakingReasons[0]).toContain("feat!:");
  });

  it("detects BREAKING CHANGE: footer as breaking", async () => {
    configForGithubApi();
    mockGetCredential.mockReturnValue("ghp_testtoken");

    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        private: false,
        fork: true,
        parent: { full_name: "Yassinello/kebab-mcp" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        status: "behind",
        ahead_by: 0,
        behind_by: 1,
        total_commits: 1,
        commits: [
          {
            sha: "abc1234",
            html_url: "https://github.com/x",
            commit: {
              message: "refactor: rewrite core\n\nBREAKING CHANGE: new API shape",
            },
          },
        ],
        html_url: "https://github.com/compare",
      })
    );

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)({
      request: new Request("http://localhost/api/config/update"),
    });
    const body = await res.json();

    expect(body.breaking).toBe(true);
    expect(body.breakingReasons).toHaveLength(1);
  });
});

// ── POST github-api: diverged guard ───────────────────────────────────

describe("POST github-api — diverged guard", () => {
  it("returns reason=diverged when ahead_by > 0", async () => {
    configForGithubApi();
    mockGetCredential.mockReturnValue("ghp_testtoken");

    // compare re-fetch
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        ahead_by: 1,
        behind_by: 2,
        html_url: "https://github.com/compare",
      })
    );

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.POST as unknown as () => Promise<Response>)();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("diverged");
    expect(body.resolveUrl).toBeTruthy();
  });
});

// ── POST github-api: successful merge ─────────────────────────────────

describe("POST github-api — successful merge", () => {
  it("returns ok=true with pulled, merge_type, deployUrl", async () => {
    configForGithubApi();
    mockGetCredential.mockReturnValue("ghp_testtoken");

    // compare re-fetch
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({ ahead_by: 0, behind_by: 2, html_url: "https://github.com/compare" })
    );

    // merge-upstream POST
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ merge_type: "fast-forward" }));

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.POST as unknown as () => Promise<Response>)();
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.pulled).toBe(2);
    expect(body.merge_type).toBe("fast-forward");
    expect(body.deployUrl).toContain("vercel.com");
  });
});

// ── POST github-api: conflict ──────────────────────────────────────────

describe("POST github-api — conflict", () => {
  it("returns reason=conflict on 409 from GitHub", async () => {
    configForGithubApi();
    mockGetCredential.mockReturnValue("ghp_testtoken");

    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({ ahead_by: 0, behind_by: 1, html_url: "https://github.com/compare" })
    );
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ message: "Merge conflict" }, 409));

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.POST as unknown as () => Promise<Response>)();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("conflict");
    expect(body.resolveUrl).toBeTruthy();
  });
});

// ── POST github-api: auth error ────────────────────────────────────────

describe("POST github-api — auth error", () => {
  it("returns reason=auth on 401 from GitHub merge-upstream", async () => {
    configForGithubApi();
    mockGetCredential.mockReturnValue("ghp_testtoken");

    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({ ahead_by: 0, behind_by: 1, html_url: "https://github.com/compare" })
    );
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ message: "Bad credentials" }, 401));

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.POST as unknown as () => Promise<Response>)();
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("auth");
  });
});

// ── POST github-api: not-a-fork ────────────────────────────────────────

describe("POST github-api — not a fork", () => {
  it("returns reason=not-a-fork on 422 from GitHub merge-upstream", async () => {
    configForGithubApi();
    mockGetCredential.mockReturnValue("ghp_testtoken");

    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({ ahead_by: 0, behind_by: 1, html_url: "https://github.com/compare" })
    );
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ message: "Validation Failed" }, 422));

    const mod = await import("../../app/api/config/update/route");
    const res = await (mod.POST as unknown as () => Promise<Response>)();
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not-a-fork");
  });
});

// ── git-CLI path still works (non-Vercel) ─────────────────────────────

describe("git-CLI path — non-Vercel", () => {
  it("GET returns available:false when not a git repo (git path)", async () => {
    configForGit();
    mockGetCredential.mockReturnValue(undefined);

    const mod = await import("../../app/api/config/update/route");
    // Non-Vercel: falls through to git path. Without a real git remote, it returns disabled-ish.
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)({
      request: new Request("http://localhost/api/config/update"),
    });
    const body = await res.json();
    // We just verify no crash and that mode is NOT github-api
    expect(body.mode).toBeUndefined();
  });
});
