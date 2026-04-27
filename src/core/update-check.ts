/**
 * Shared update-check helper — used by:
 *   - app/api/config/update/route.ts (cache-first GET handler, Phase 63 Plan 01)
 *   - app/api/cron/update-check/route.ts (daily cron, Phase 63 Plan 02)
 *
 * Pure: takes a resolved PAT + fork owner/slug, calls GitHub Compare,
 * returns a discriminated union. NEVER reaches into KV, auth, or
 * credential hydration — the caller has already done that.
 *
 * The cache constants (UPDATE_CHECK_KV_KEY, UPDATE_CHECK_TTL_SECONDS,
 * UPDATE_CHECK_STALE_MS) are exported so the route GET handler and the
 * cron route can share the exact same KV shape + freshness window.
 */

// `@/*` maps to `./src/*` only — `app/landing/deploy-url` lives outside
// the alias and must be imported relatively from src/core.
import { UPSTREAM_OWNER, UPSTREAM_REPO_SLUG } from "../../app/landing/deploy-url";
import { getConfig } from "./config-facade";
import { getCredential } from "./request-context";

// ── Cache constants (re-used by the cron + route cache-first read) ──────
export const UPDATE_CHECK_KV_KEY = "global:update-check";
export const UPDATE_CHECK_TTL_SECONDS = 48 * 60 * 60; // 48h — D-04
export const UPDATE_CHECK_STALE_MS = UPDATE_CHECK_TTL_SECONDS * 1000;
export const UPDATE_CHECK_LOCK_KEY = "global:update-check:lock";
export const UPDATE_CHECK_LOCK_TTL_SECONDS = 60; // 60s anti-stampede

// ── Token resolution (shared by GET, POST, cron) ───────────────────────
//
// Resolution order: dedicated PAT first, fallback GITHUB_TOKEN. Each key
// is resolved through getCredential() (which walks: request-scoped
// override → live process.env runtime keys → frozen boot env) before
// falling back to getConfig() for full env-facade coverage.
export function resolveUpdateToken(): string | null {
  return (
    (getCredential("KEBAB_UPDATE_PAT") ?? getConfig("KEBAB_UPDATE_PAT")) ||
    (getCredential("GITHUB_TOKEN") ?? getConfig("GITHUB_TOKEN")) ||
    null
  );
}

// ── GitHub API constants (moved from route.ts) ─────────────────────────
const GH_API_VERSION = "2022-11-28";
const GH_ACCEPT = "application/vnd.github+json";

export interface GitHubFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
  scopesHeader: string | null;
}

/**
 * Thin GitHub REST helper used by `computeUpdateStatus()` and re-exported
 * for the POST `/api/config/update` merge-upstream path (which lives outside
 * this module's scope but shares the same auth + headers).
 */
export async function ghFetch(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {}
): Promise<GitHubFetchResult> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: GH_ACCEPT,
      "X-GitHub-Api-Version": GH_API_VERSION,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data, scopesHeader: res.headers.get("x-oauth-scopes") };
}

// ── Breaking-change detection ──────────────────────────────────────────

/**
 * Detect breaking-change indicators in a list of commits.
 *
 * Two signals (either fires):
 *   - Conventional-commit "bang" prefix (`feat!:`, `refactor!:`, etc.)
 *   - `BREAKING CHANGE:` footer (anywhere in the message body)
 *
 * Returns the matched first-line of each offending commit (truncated to
 * 80 chars) so the dashboard can surface human-readable reasons.
 */
function detectBreaking(commits: Array<{ commit: { message: string } }>): {
  breaking: boolean;
  breakingReasons: string[];
} {
  const reasons: string[] = [];
  const CONV_BANG = /^(?:feat|fix|refactor|perf|chore|docs|style|test|build|ci)!:/m;
  const BREAK_FOOTER = /BREAKING CHANGE:/m;
  for (const c of commits) {
    const msg = c.commit.message;
    if (CONV_BANG.test(msg)) reasons.push(msg.split("\n")[0]!.slice(0, 80));
    else if (BREAK_FOOTER.test(msg)) reasons.push(msg.split("\n")[0]!.slice(0, 80));
  }
  return { breaking: reasons.length > 0, breakingReasons: reasons };
}

// ── Public types ───────────────────────────────────────────────────────

export type UpdateStatusPayload = {
  /** ISO 8601 timestamp captured at compute time (used by cache freshness checks). */
  checkedAt: string;
  mode: "github-api";
  available: boolean;
  behind_by: number;
  ahead_by: number;
  status: "ahead" | "behind" | "diverged" | "identical";
  breaking: boolean;
  breakingReasons: string[];
  commits: Array<{ sha: string; message: string; url: string }>;
  totalCommits: number;
  diffUrl: string;
  tokenConfigured: true;
  forkPrivate: boolean;
};

export type UpdateStatusResult =
  | { ok: true; payload: UpdateStatusPayload }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "fetch"; status: number }
  | { ok: false; kind: "not-a-fork"; deployedRepo: string };

/**
 * Compute the upstream-vs-fork status using GitHub Compare API.
 * Pure: takes resolved token + owner + slug; does NOT do auth, credential
 * hydration, or KV reads. Used by both /api/config/update GET handler
 * (cache-first) and /api/cron/update-check.
 *
 * Returns a discriminated union:
 *   { ok: true, payload: UpdateStatusPayload }  on success (any GitHub status)
 *   { ok: false, kind: "auth" }                  on 401/403 from /repos
 *   { ok: false, kind: "fetch", status: number } on any other 5xx/4xx
 *
 * Caller decides response shape (route returns NextResponse, cron logs+writes-empty).
 *
 * Phase 62 STAB-01 lock: BASE...HEAD URL direction is preserved —
 *   const upstream = `${UPSTREAM_OWNER}:${UPSTREAM_REPO_SLUG}:main`;
 *   `compare/${upstream}...main`  ← DO NOT INVERT
 */
export async function computeUpdateStatus(
  token: string,
  owner: string,
  slug: string
): Promise<UpdateStatusResult> {
  const upstream = `${UPSTREAM_OWNER}:${UPSTREAM_REPO_SLUG}:main`;

  // Fetch repo metadata. We need: visibility (public/private), fork status,
  // and the parent repo if any. A deploy that came from `/new/clone` will
  // have `fork: false` and `parent: null` even though the files match
  // upstream — those repos have no shared git history with upstream and
  // CANNOT receive merge-upstream pulls. We detect this and short-circuit
  // with a clear error so the user sees an actionable message instead of
  // a stale "up to date" banner.
  const repoRes = await ghFetch(`/repos/${owner}/${slug}`, token);
  if (!repoRes.ok) {
    if (repoRes.status === 401 || repoRes.status === 403) {
      return { ok: false, kind: "auth" };
    }
    return { ok: false, kind: "fetch", status: repoRes.status };
  }
  const repoData = repoRes.data as {
    private: boolean;
    fork: boolean;
    parent: { full_name: string } | null;
  };
  const forkPrivate = repoData.private ?? false;

  // Detect the "standalone clone" failure mode: deployed repo isn't a fork,
  // OR is a fork but its parent points somewhere other than our upstream.
  // Either way, the merge-upstream API will not work and the Compare API
  // results are misleading (it compares file trees, not history, and
  // returns "identical" for snapshots even when the user is a year behind).
  const upstreamFullName = `${UPSTREAM_OWNER}/${UPSTREAM_REPO_SLUG}`;
  const isUpstreamFork = repoData.fork === true && repoData.parent?.full_name === upstreamFullName;
  if (!isUpstreamFork) {
    return {
      ok: false,
      kind: "not-a-fork",
      deployedRepo: `${owner}/${slug}`,
    };
  }

  // Compare fork HEAD with upstream
  // BASE=upstream, HEAD=fork → response describes fork's position relative to upstream
  // (status: "behind" + behind_by:N means fork is N commits behind upstream → updates available)
  const compareRes = await ghFetch(`/repos/${owner}/${slug}/compare/${upstream}...main`, token);
  if (!compareRes.ok) {
    return { ok: false, kind: "fetch", status: compareRes.status };
  }

  const cmp = compareRes.data as {
    status: "ahead" | "behind" | "diverged" | "identical";
    ahead_by: number;
    behind_by: number;
    total_commits: number;
    commits: Array<{ sha: string; html_url: string; commit: { message: string } }>;
    html_url: string;
  };

  const { breaking, breakingReasons } = detectBreaking(cmp.commits);
  const displayCommits = [...cmp.commits]
    .reverse()
    .slice(0, 5)
    .map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0]!.slice(0, 80),
      url: c.html_url,
    }));

  const payload: UpdateStatusPayload = {
    checkedAt: new Date().toISOString(),
    mode: "github-api",
    available: cmp.status === "behind",
    behind_by: cmp.behind_by,
    ahead_by: cmp.ahead_by,
    status: cmp.status,
    breaking,
    breakingReasons,
    commits: displayCommits,
    totalCommits: cmp.total_commits,
    diffUrl: cmp.html_url,
    tokenConfigured: true,
    forkPrivate,
  };

  return { ok: true, payload };
}
