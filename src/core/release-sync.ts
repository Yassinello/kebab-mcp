/**
 * Release sync — the update path for deployments whose GitHub repo is NOT a
 * fork of upstream (Kebab House phase 2, UPD-01..05).
 *
 * Why: the Vercel Deploy Button (`/new/clone`) creates a standalone copy of
 * upstream, with no fork link. GitHub's `merge-upstream` rejects those
 * repos, so the fork update flow can't help them. Release sync works on
 * file contents instead of git history:
 *
 *   1. Base = the upstream COMMIT the user's files came from (see
 *      detectSyncBase): the `Kebab-Upstream-Commit` trailer of the last
 *      sync, else the upstream commit whose tree equals the user's root
 *      commit (a Deploy Button clone is one commit holding upstream `main`
 *      as it was that day, usually past the last release tag), else the
 *      release tag of `version` in the repo's package.json. Target =
 *      upstream's latest release. A base already at or past the target is
 *      "up to date" (never a downgrade).
 *   2. Upstream `compare` between the two commits → changed paths
 *      (added / modified / removed / renamed).
 *   3. Conflict check BEFORE any write: for every path we would touch, the
 *      user's blob must equal the upstream blob at the base (or already
 *      equal the target). Anything else is a local edit → stop and list
 *      the files.
 *   4. Blobs are copied into the user's repo one by one (sequenced calls),
 *      a tree is built on top of the user's current tree, a commit
 *      "chore: sync Kebab House vX.Y.Z" (with the `Kebab-Upstream-Commit`
 *      trailer naming the target commit) is created with the user's HEAD as
 *      parent, and only then is `refs/heads/<default branch>` moved
 *      (fast-forward only). A failure anywhere before that last call leaves
 *      the repo untouched — orphan blobs/trees are invisible and GC'd.
 *
 * Forks keep `merge-upstream` (src/core/update-check.ts) — unchanged.
 *
 * `.github/workflows/` is never written nor checked: GitHub refuses
 * workflow-file pushes from tokens without the `workflows` permission, and
 * CI files are not needed for the instance to run.
 */

// `@/*` maps to `./src/*` only — `app/landing/deploy-url` lives outside
// the alias and must be imported relatively from src/core.
import { UPSTREAM_OWNER, UPSTREAM_REPO_SLUG } from "../../app/landing/deploy-url";
import {
  computeUpdateStatus,
  detectBreaking,
  ghFetch,
  type UpdateStatusPayload,
} from "./update-check";
import { VERSION } from "./version";
import { toMsg } from "./error-utils";

// ── Limits (UPD-05) ────────────────────────────────────────────────────

export const RELEASE_SYNC_MAX_FILES = 500;
export const RELEASE_SYNC_MAX_BYTES = 20 * 1024 * 1024;
/** GitHub's compare API lists at most 300 files; past that we diff trees. */
const COMPARE_FILES_CAP = 300;
const EXCLUDED_PREFIXES = [".github/workflows/"];
/** GitHub's max page size for the commits list. */
const COMMITS_PAGE = 100;
/** How many pages of upstream history to scan for the commit a clone came from (~300 commits). */
const UPSTREAM_SCAN_PAGES = 3;
/** Trailer written on every sync commit: the upstream commit the repo now matches. */
export const UPSTREAM_COMMIT_TRAILER = "Kebab-Upstream-Commit";

const UPSTREAM_FULL = `${UPSTREAM_OWNER}/${UPSTREAM_REPO_SLUG}`;
const UPSTREAM_RELEASES_URL = `https://github.com/${UPSTREAM_FULL}/releases`;

// ── Types ──────────────────────────────────────────────────────────────

export interface DeployedRepo {
  owner: string;
  slug: string;
  defaultBranch: string;
  private: boolean;
}

export type ReleaseSyncStatusPayload = {
  checkedAt: string;
  mode: "release-sync";
  available: boolean;
  behind_by: number;
  ahead_by: 0;
  status: "behind" | "identical";
  breaking: boolean;
  breakingReasons: string[];
  commits: Array<{ sha: string; message: string; url: string }>;
  totalCommits: number;
  diffUrl: string;
  tokenConfigured: true;
  forkPrivate: boolean;
  deployedRepo: string;
  installedVersion: string;
  latestVersion: string;
  releaseUrl: string;
  filesChanged: number;
};

export type ReleaseSyncStatusResult =
  | { ok: true; payload: ReleaseSyncStatusPayload }
  | { ok: false; kind: "auth"; mode: "release-sync" }
  | { ok: false; kind: "fetch"; status: number; mode: "release-sync" }
  | {
      ok: false;
      kind: "unknown-version";
      mode: "release-sync";
      installedVersion: string;
      message: string;
    };

export type ReleaseSyncFailure =
  | {
      ok: false;
      reason: "conflict";
      message: string;
      fromVersion: string;
      toVersion: string;
      conflicts: string[];
      manualUrl: string;
    }
  | { ok: false; reason: "head-moved"; message: string }
  | {
      ok: false;
      reason: "too-large";
      message: string;
      files: number;
      bytes: number;
      manualUrl: string;
    }
  | { ok: false; reason: "unknown-version"; message: string; version: string }
  | { ok: false; reason: "no-release"; message: string }
  | { ok: false; reason: "auth"; message: string; step: string }
  | { ok: false; reason: "github-error"; message: string; step: string; status: number }
  | { ok: false; reason: "integrity"; message: string; path: string };

export type ReleaseSyncApplyResult =
  | { ok: true; upToDate: true; version: string }
  | {
      ok: true;
      upToDate: false;
      fromVersion: string;
      toVersion: string;
      commitSha: string;
      commitUrl: string;
      /** Upstream commits between the two releases (for the "Synced N" UI). */
      pulled: number;
      added: string[];
      modified: string[];
      removed: string[];
      skipped: string[];
    }
  | ReleaseSyncFailure;

interface TreeEntry {
  sha: string;
  mode: string;
  size: number;
}
type TreeMap = Map<string, TreeEntry>;

interface ReleaseCommit {
  tag: string;
  commitSha: string;
  treeSha: string;
}

interface CompareFile {
  filename: string;
  status: string;
  previous_filename?: string;
}

interface CompareData {
  /** `ahead`: the second commit is ahead of the first; `behind`, `identical`, `diverged`. */
  status?: string;
  total_commits: number;
  html_url: string;
  commits: Array<{ sha: string; html_url: string; commit: { message: string } }>;
  files?: CompareFile[];
}

// ── Version helpers (UPD-02) ───────────────────────────────────────────

/** release-please tags are `v<version>` (`include-v-in-tag: true`). */
export function releaseTagFor(version: string): string {
  return `v${version.trim().replace(/^v/, "")}`;
}

/** Numeric x.y.z comparison; pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ── GitHub plumbing ────────────────────────────────────────────────────

/** Internal control flow: thrown by helpers, turned into a result at the top. */
class SyncAbort extends Error {
  constructor(readonly result: ReleaseSyncFailure) {
    super(result.message);
  }
}

function ghMessage(data: unknown): string {
  const m = (data as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : "";
}

function failFromStatus(step: string, status: number, data: unknown): SyncAbort {
  const detail = ghMessage(data);
  if (status === 401 || status === 403) {
    return new SyncAbort({
      ok: false,
      reason: "auth",
      step,
      message:
        `GitHub refused the update token at step "${step}"${detail ? ` (${detail})` : ""}. ` +
        "The token (KEBAB_UPDATE_PAT or GITHUB_TOKEN) needs Contents: read & write on your repo.",
    });
  }
  return new SyncAbort({
    ok: false,
    reason: "github-error",
    step,
    status,
    message: `GitHub API error at step "${step}" (HTTP ${status})${detail ? `: ${detail}` : ""}. Nothing was changed in your repo.`,
  });
}

async function gh<T>(
  step: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  let res;
  try {
    res = await ghFetch(path, token, options);
  } catch (err) {
    throw new SyncAbort({
      ok: false,
      reason: "github-error",
      step,
      status: 0,
      message: `Network error at step "${step}": ${toMsg(err)}. Nothing was changed in your repo.`,
    });
  }
  if (!res.ok) throw failFromStatus(step, res.status, res.data);
  return res.data as T;
}

function refPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

async function readHead(token: string, repo: string, branch: string): Promise<string> {
  const ref = await gh<{ object: { sha: string } }>(
    "read-branch",
    `/repos/${repo}/git/ref/heads/${refPath(branch)}`,
    token
  );
  return ref.object.sha;
}

/**
 * UPD-02: the installed upstream version. In a clone the build commit
 * (VERCEL_GIT_COMMIT_SHA) is not an upstream commit, so we read the
 * `version` field of package.json in the user's repo at `ref`, falling back
 * to the running VERSION constant (same file, as built).
 */
export async function readInstalledVersion(
  token: string,
  repo: string,
  ref: string
): Promise<string> {
  const res = await ghFetch(
    `/repos/${repo}/contents/package.json?ref=${encodeURIComponent(ref)}`,
    token
  ).catch(() => null);
  if (res && (res.status === 401 || res.status === 403)) {
    throw failFromStatus("read-version", res.status, res.data);
  }
  if (res?.ok) {
    const d = res.data as { content?: string; encoding?: string };
    if (typeof d.content === "string" && d.encoding === "base64") {
      try {
        const pkg = JSON.parse(Buffer.from(d.content, "base64").toString("utf8")) as {
          version?: unknown;
        };
        if (typeof pkg.version === "string" && pkg.version.trim()) return pkg.version.trim();
      } catch {
        // malformed package.json in the user's repo — fall back to the build's version
      }
    }
  }
  return VERSION;
}

/**
 * UPD-02: upstream release tag → commit (+ its tree). Handles annotated
 * tags (ref → tag object → commit). Returns null when the tag is unknown.
 */
export async function resolveReleaseCommit(
  token: string,
  tag: string
): Promise<ReleaseCommit | null> {
  const step = "resolve-tag";
  let ref;
  try {
    ref = await ghFetch(`/repos/${UPSTREAM_FULL}/git/ref/tags/${encodeURIComponent(tag)}`, token);
  } catch {
    throw failFromStatus(step, 0, null);
  }
  if (ref.status === 404) return null;
  if (!ref.ok) throw failFromStatus(step, ref.status, ref.data);
  let obj = (ref.data as { object: { type: string; sha: string } }).object;
  for (let hops = 0; obj.type === "tag" && hops < 5; hops++) {
    obj = (
      await gh<{ object: { type: string; sha: string } }>(
        step,
        `/repos/${UPSTREAM_FULL}/git/tags/${obj.sha}`,
        token
      )
    ).object;
  }
  if (obj.type !== "commit") return null;
  const commit = await gh<{ tree: { sha: string } }>(
    "read-release-commit",
    `/repos/${UPSTREAM_FULL}/git/commits/${obj.sha}`,
    token
  );
  return { tag, commitSha: obj.sha, treeSha: commit.tree.sha };
}

/** Where the user's files came from upstream (D3, 2026-11 audit). */
export interface SyncBase {
  commitSha: string;
  treeSha: string;
  /** trailer = recorded by a previous sync; root-tree = clone detected by its first commit; tag = package.json version. */
  source: "trailer" | "root-tree" | "tag";
  /** Human label for messages: "v0.1.16" or "upstream commit abc1234". */
  label: string;
}

interface ListedCommit {
  sha: string;
  commit: { message: string; tree: { sha: string } };
  parents: Array<{ sha: string }>;
}

/** One page of a branch's history (newest first); null when GitHub can't list it. */
async function listCommits(
  token: string,
  repo: string,
  ref: string | null,
  page: number
): Promise<ListedCommit[] | null> {
  const q = `${ref ? `sha=${encodeURIComponent(ref)}&` : ""}per_page=${COMMITS_PAGE}&page=${page}`;
  let res;
  try {
    res = await ghFetch(`/repos/${repo}/commits?${q}`, token);
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403) {
    throw failFromStatus("list-commits", res.status, res.data);
  }
  return res.ok && Array.isArray(res.data) ? (res.data as ListedCommit[]) : null;
}

function commitBase(commitSha: string, treeSha: string, source: SyncBase["source"]): SyncBase {
  return { commitSha, treeSha, source, label: `upstream commit ${commitSha.slice(0, 7)}` };
}

const TRAILER_RE = new RegExp(`^${UPSTREAM_COMMIT_TRAILER}:\\s*([0-9a-f]{7,40})\\s*$`, "m");
const LEGACY_SYNC_RE = /^chore: sync Kebab House v(\S+)/;

/**
 * D3 (2026-11 audit): find the upstream commit the user's repo was created
 * from or last synced to. Using package.json's version alone was wrong for
 * Deploy Button clones: the button clones `main`, which is usually past the
 * last release tag while still declaring that release's version, so every
 * file changed on `main` since the tag looked like a local edit.
 *
 *   1. The newest `Kebab-Upstream-Commit:` trailer in the user's recent
 *      history (written by every sync). A legacy sync commit without the
 *      trailer ("chore: sync Kebab House vX.Y.Z") means the tag vX.Y.Z.
 *   2. The user's root commit (a clone is one initial commit): the upstream
 *      commit, among the ~300 most recent on the default branch, with the
 *      same tree.
 *   3. The release tag of the installed version (package.json).
 */
export async function detectSyncBase(
  token: string,
  userRepo: string,
  ref: string,
  installedVersion: string
): Promise<SyncBase | null> {
  const userCommits = await listCommits(token, userRepo, ref, 1);
  if (userCommits) {
    for (const c of userCommits) {
      const msg = c.commit?.message ?? "";
      const recorded = msg.match(TRAILER_RE)?.[1];
      if (recorded) {
        const res = await ghFetch(`/repos/${UPSTREAM_FULL}/git/commits/${recorded}`, token).catch(
          () => null
        );
        const data = (res?.data ?? null) as { sha?: string; tree?: { sha?: string } } | null;
        if (res?.ok && data?.tree?.sha) {
          return commitBase(data.sha ?? recorded, data.tree.sha, "trailer");
        }
        break; // unknown upstream commit (history rewritten?): fall back below
      }
      const legacy = msg.match(LEGACY_SYNC_RE)?.[1];
      if (legacy) {
        const rel = await resolveReleaseCommit(token, releaseTagFor(legacy));
        if (rel) {
          return {
            commitSha: rel.commitSha,
            treeSha: rel.treeSha,
            source: "tag",
            label: releaseTagFor(legacy),
          };
        }
        break;
      }
    }

    const root = userCommits.length < COMMITS_PAGE ? userCommits.at(-1) : undefined;
    const rootTree = root && root.parents.length === 0 ? root.commit?.tree?.sha : undefined;
    if (rootTree) {
      for (let page = 1; page <= UPSTREAM_SCAN_PAGES; page++) {
        const upstream = await listCommits(token, UPSTREAM_FULL, null, page);
        if (!upstream) break;
        const hit = upstream.find((c) => c.commit?.tree?.sha === rootTree);
        if (hit) return commitBase(hit.sha, rootTree, "root-tree");
        if (upstream.length < COMMITS_PAGE) break;
      }
    }
  }

  const rel = await resolveReleaseCommit(token, releaseTagFor(installedVersion));
  return rel
    ? {
        commitSha: rel.commitSha,
        treeSha: rel.treeSha,
        source: "tag",
        label: releaseTagFor(installedVersion),
      }
    : null;
}

/** The base already contains the target release (same commit, or newer): nothing to sync. */
function baseIsAtOrPastTarget(cmp: CompareData): boolean {
  return cmp.status === "identical" || cmp.status === "behind";
}

async function getLatestRelease(
  token: string
): Promise<{ tag: string; version: string; url: string } | null> {
  let res;
  try {
    res = await ghFetch(`/repos/${UPSTREAM_FULL}/releases/latest`, token);
  } catch {
    throw failFromStatus("latest-release", 0, null);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw failFromStatus("latest-release", res.status, res.data);
  const d = res.data as { tag_name: string; html_url?: string };
  return {
    tag: d.tag_name,
    version: d.tag_name.replace(/^v/, ""),
    url: d.html_url || `${UPSTREAM_RELEASES_URL}/tag/${d.tag_name}`,
  };
}

async function readTree(token: string, repo: string, treeSha: string): Promise<TreeMap> {
  const data = await gh<{
    truncated?: boolean;
    tree: Array<{ path: string; type: string; sha: string; mode: string; size?: number }>;
  }>("read-tree", `/repos/${repo}/git/trees/${treeSha}?recursive=1`, token);
  if (data.truncated) {
    throw new SyncAbort({
      ok: false,
      reason: "too-large",
      files: data.tree.length,
      bytes: 0,
      manualUrl: UPSTREAM_RELEASES_URL,
      message: `The file tree of ${repo} is too large for GitHub to list in one call. Update manually from the release page.`,
    });
  }
  const map: TreeMap = new Map();
  for (const e of data.tree) {
    if (e.type !== "blob") continue;
    map.set(e.path, { sha: e.sha, mode: e.mode, size: e.size ?? 0 });
  }
  return map;
}

function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => path.startsWith(p));
}

function pathsFromCompare(files: CompareFile[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    out.add(f.filename);
    if (f.status === "renamed" && f.previous_filename) out.add(f.previous_filename);
  }
  return [...out];
}

function diffTrees(a: TreeMap, b: TreeMap): string[] {
  const out = new Set<string>();
  for (const [path, e] of a) if (b.get(path)?.sha !== e.sha) out.add(path);
  for (const path of b.keys()) if (!a.has(path)) out.add(path);
  return [...out];
}

// ── Planning (pure) ────────────────────────────────────────────────────

export interface SyncPlan {
  writes: Array<{
    path: string;
    sha: string;
    mode: string;
    size: number;
    kind: "added" | "modified";
  }>;
  removals: Array<{ path: string; mode: string }>;
  conflicts: string[];
  skipped: string[];
}

/**
 * Decide, path by path, what the sync does. For each path:
 *   user === target            → nothing to do (already there)
 *   user === base (installed)  → apply the upstream change
 *   anything else              → user-modified → conflict
 * "absent" is a value too (null), so a removed or renamed path follows the
 * same rule: a rename is the removal of the old path plus the addition of
 * the new one.
 */
export function planReleaseSync(
  paths: string[],
  base: TreeMap,
  target: TreeMap,
  user: TreeMap
): SyncPlan {
  const plan: SyncPlan = { writes: [], removals: [], conflicts: [], skipped: [] };
  for (const path of [...paths].sort()) {
    if (isExcluded(path)) {
      plan.skipped.push(path);
      continue;
    }
    const u = user.get(path) ?? null;
    const b = base.get(path) ?? null;
    const t = target.get(path) ?? null;
    if ((u?.sha ?? null) === (t?.sha ?? null)) continue;
    if ((u?.sha ?? null) !== (b?.sha ?? null)) {
      plan.conflicts.push(path);
      continue;
    }
    if (t) {
      plan.writes.push({
        path,
        sha: t.sha,
        mode: t.mode,
        size: t.size,
        kind: b ? "modified" : "added",
      });
    } else if (u) {
      plan.removals.push({ path, mode: u.mode });
    }
  }
  return plan;
}

// ── Status (GET) ───────────────────────────────────────────────────────

/**
 * Release-sync update status for a non-fork deployment: installed version
 * vs. upstream's latest release, plus the upstream commits in between.
 */
export async function computeReleaseSyncStatus(
  token: string,
  repo: DeployedRepo
): Promise<ReleaseSyncStatusResult> {
  const deployedRepo = `${repo.owner}/${repo.slug}`;
  try {
    const installedVersion = await readInstalledVersion(token, deployedRepo, repo.defaultBranch);
    const latest = await getLatestRelease(token);
    const base: Omit<ReleaseSyncStatusPayload, "available" | "status"> = {
      checkedAt: new Date().toISOString(),
      mode: "release-sync",
      behind_by: 0,
      ahead_by: 0,
      breaking: false,
      breakingReasons: [],
      commits: [],
      totalCommits: 0,
      diffUrl: latest?.url ?? UPSTREAM_RELEASES_URL,
      tokenConfigured: true,
      forkPrivate: repo.private,
      deployedRepo,
      installedVersion,
      latestVersion: latest?.version ?? installedVersion,
      releaseUrl: latest?.url ?? UPSTREAM_RELEASES_URL,
      filesChanged: 0,
    };
    if (!latest || compareVersions(latest.version, installedVersion) <= 0) {
      return { ok: true, payload: { ...base, available: false, status: "identical" } };
    }

    const from = await detectSyncBase(token, deployedRepo, repo.defaultBranch, installedVersion);
    const to = await resolveReleaseCommit(token, latest.tag);
    if (!from || !to) {
      return {
        ok: false,
        kind: "unknown-version",
        mode: "release-sync",
        installedVersion,
        message: `Version ${installedVersion} (package.json in ${deployedRepo}) does not match an upstream release tag, so the files to update can't be computed. Update manually from ${UPSTREAM_RELEASES_URL}.`,
      };
    }
    const cmp = await gh<CompareData>(
      "compare",
      `/repos/${UPSTREAM_FULL}/compare/${from.commitSha}...${to.commitSha}`,
      token
    );
    if (baseIsAtOrPastTarget(cmp)) {
      // A clone of `main` taken after the latest release: newer than the
      // release, so nothing to propose (and never a downgrade).
      return {
        ok: true,
        payload: {
          ...base,
          latestVersion: installedVersion,
          available: false,
          status: "identical",
        },
      };
    }
    const { breaking, breakingReasons } = detectBreaking(cmp.commits);
    return {
      ok: true,
      payload: {
        ...base,
        available: true,
        status: "behind",
        behind_by: cmp.total_commits,
        breaking,
        breakingReasons,
        commits: [...cmp.commits]
          .reverse()
          .slice(0, 5)
          .map((c) => ({
            sha: c.sha.slice(0, 7),
            message: c.commit.message.split("\n")[0]!.slice(0, 80),
            url: c.html_url,
          })),
        totalCommits: cmp.total_commits,
        diffUrl: cmp.html_url,
        filesChanged: cmp.files?.length ?? 0,
      },
    };
  } catch (err) {
    if (!(err instanceof SyncAbort)) throw err;
    if (err.result.reason === "auth") return { ok: false, kind: "auth", mode: "release-sync" };
    const status = err.result.reason === "github-error" ? err.result.status : 502;
    return { ok: false, kind: "fetch", status, mode: "release-sync" };
  }
}

export type DeploymentUpdateStatusResult =
  | { ok: true; payload: UpdateStatusPayload | ReleaseSyncStatusPayload }
  | { ok: false; kind: "auth"; mode?: "release-sync" }
  | { ok: false; kind: "fetch"; status: number; mode?: "release-sync" }
  | Extract<ReleaseSyncStatusResult, { kind: "unknown-version" }>;

/**
 * Mode selection (UPD-04): forks of upstream → `github-api`
 * (merge-upstream, unchanged); every other repo → `release-sync`.
 * Shared by GET /api/config/update and the daily cron.
 */
export async function computeDeploymentUpdateStatus(
  token: string,
  owner: string,
  slug: string
): Promise<DeploymentUpdateStatusResult> {
  const result = await computeUpdateStatus(token, owner, slug);
  if (result.ok || result.kind !== "not-a-fork") return result;
  return computeReleaseSyncStatus(token, {
    owner,
    slug,
    defaultBranch: result.defaultBranch,
    private: result.forkPrivate,
  });
}

// ── Apply (POST) ───────────────────────────────────────────────────────

/**
 * Run a release sync against the user's repo. Never throws for GitHub
 * failures — every outcome is a result object. The branch ref is only
 * moved by the very last call, and only as a fast-forward of the HEAD the
 * sync started from.
 */
export async function applyReleaseSync(
  token: string,
  repo: DeployedRepo
): Promise<ReleaseSyncApplyResult> {
  try {
    return await applyReleaseSyncInner(token, repo);
  } catch (err) {
    if (err instanceof SyncAbort) return err.result;
    throw err;
  }
}

async function applyReleaseSyncInner(
  token: string,
  repo: DeployedRepo
): Promise<ReleaseSyncApplyResult> {
  const userRepo = `${repo.owner}/${repo.slug}`;
  const branch = repo.defaultBranch;

  // 1. Where the user's repo is now.
  const headSha = await readHead(token, userRepo, branch);
  const headCommit = await gh<{ tree: { sha: string } }>(
    "read-head-commit",
    `/repos/${userRepo}/git/commits/${headSha}`,
    token
  );

  // 2. Installed version → target release.
  const fromVersion = await readInstalledVersion(token, userRepo, headSha);
  const latest = await getLatestRelease(token);
  if (!latest) {
    return {
      ok: false,
      reason: "no-release",
      message: `No published release found on ${UPSTREAM_FULL}.`,
    };
  }
  if (compareVersions(latest.version, fromVersion) <= 0) {
    return { ok: true, upToDate: true, version: fromVersion };
  }
  const toVersion = latest.version;

  const from = await detectSyncBase(token, userRepo, headSha, fromVersion);
  if (!from) {
    return {
      ok: false,
      reason: "unknown-version",
      version: fromVersion,
      message: `Version ${fromVersion} (package.json in ${userRepo}) is not an upstream release tag, so release sync can't tell which files you have. Update manually from ${UPSTREAM_RELEASES_URL}.`,
    };
  }
  const to = await resolveReleaseCommit(token, latest.tag);
  if (!to) {
    return {
      ok: false,
      reason: "unknown-version",
      version: toVersion,
      message: `Upstream release ${latest.tag} has no matching tag. Try again later.`,
    };
  }

  const manualUrl = `https://github.com/${UPSTREAM_FULL}/compare/${
    from.source === "tag" ? from.label : from.commitSha.slice(0, 12)
  }...${latest.tag}`;

  // 3. What changed upstream between the base and the target release.
  const cmp = await gh<CompareData>(
    "compare",
    `/repos/${UPSTREAM_FULL}/compare/${from.commitSha}...${to.commitSha}`,
    token
  );
  if (baseIsAtOrPastTarget(cmp)) return { ok: true, upToDate: true, version: fromVersion };
  const files = cmp.files ?? [];

  // 4. The three trees: upstream at the base, upstream at target, user now.
  const baseTree = await readTree(token, UPSTREAM_FULL, from.treeSha);
  const targetTree = await readTree(token, UPSTREAM_FULL, to.treeSha);
  const userTree = await readTree(token, userRepo, headCommit.tree.sha);
  const paths =
    files.length >= COMPARE_FILES_CAP ? diffTrees(baseTree, targetTree) : pathsFromCompare(files);

  // 5. Plan + limits + conflicts — all before the first write.
  const plan = planReleaseSync(paths, baseTree, targetTree, userTree);
  const fileCount = plan.writes.length + plan.removals.length;
  const bytes = plan.writes.reduce((n, w) => n + w.size, 0);
  if (fileCount > RELEASE_SYNC_MAX_FILES || bytes > RELEASE_SYNC_MAX_BYTES) {
    return {
      ok: false,
      reason: "too-large",
      files: fileCount,
      bytes,
      manualUrl,
      message:
        `This update touches ${fileCount} files (${(bytes / 1024 / 1024).toFixed(1)} MB); ` +
        `release sync is limited to ${RELEASE_SYNC_MAX_FILES} files and ` +
        `${RELEASE_SYNC_MAX_BYTES / 1024 / 1024} MB. Apply v${toVersion} manually (see the compare link).`,
    };
  }
  if (plan.conflicts.length > 0) {
    return {
      ok: false,
      reason: "conflict",
      fromVersion,
      toVersion,
      conflicts: plan.conflicts,
      manualUrl,
      message:
        `${plan.conflicts.length} file${plan.conflicts.length === 1 ? " was" : "s were"} changed in ` +
        `${userRepo} since ${from.label}, and v${toVersion} changes ${plan.conflicts.length === 1 ? "it" : "them"} too. ` +
        "Release sync never overwrites your edits, so nothing was written. Restore these files to " +
        `their ${from.label} content (or port your edits after updating by hand), then retry.`,
    };
  }
  if (fileCount === 0) return { ok: true, upToDate: true, version: toVersion };

  // 6. Copy blobs (sequenced — one call at a time keeps us far from the
  //    secondary rate limits). Git blob SHAs are content hashes, so the
  //    SHA GitHub returns must equal upstream's: a cheap integrity check.
  const copied = new Set<string>();
  for (const w of plan.writes) {
    if (copied.has(w.sha)) continue;
    const blob = await gh<{ content: string; encoding: string }>(
      "read-upstream-blob",
      `/repos/${UPSTREAM_FULL}/git/blobs/${w.sha}`,
      token
    );
    const created = await gh<{ sha: string }>(
      "create-blob",
      `/repos/${userRepo}/git/blobs`,
      token,
      {
        method: "POST",
        body: {
          content:
            blob.encoding === "base64"
              ? blob.content.replace(/\n/g, "")
              : Buffer.from(blob.content, "utf8").toString("base64"),
          encoding: "base64",
        },
      }
    );
    if (created.sha !== w.sha) {
      return {
        ok: false,
        reason: "integrity",
        path: w.path,
        message: `Copied content of ${w.path} does not match upstream. Nothing was changed in your repo.`,
      };
    }
    copied.add(w.sha);
  }

  // 7. Tree on top of the user's current tree, then the commit.
  const tree = await gh<{ sha: string }>("create-tree", `/repos/${userRepo}/git/trees`, token, {
    method: "POST",
    body: {
      base_tree: headCommit.tree.sha,
      tree: [
        ...plan.writes.map((w) => ({ path: w.path, mode: w.mode, type: "blob", sha: w.sha })),
        ...plan.removals.map((r) => ({ path: r.path, mode: r.mode, type: "blob", sha: null })),
      ],
    },
  });
  const commit = await gh<{ sha: string; html_url?: string }>(
    "create-commit",
    `/repos/${userRepo}/git/commits`,
    token,
    {
      method: "POST",
      body: {
        message:
          `chore: sync Kebab House v${toVersion}\n\n` +
          `Release sync from ${UPSTREAM_FULL} ${from.label} → v${toVersion}.\n` +
          `Upstream changes: ${cmp.html_url}\n\n` +
          `${UPSTREAM_COMMIT_TRAILER}: ${to.commitSha}`,
        tree: tree.sha,
        parents: [headSha],
      },
    }
  );

  // 8. Fast-forward only. Re-read HEAD first for a clear error; the PATCH
  //    with force:false is the real guard (GitHub refuses non-FF moves).
  const currentHead = await readHead(token, userRepo, branch);
  const headMoved: ReleaseSyncFailure = {
    ok: false,
    reason: "head-moved",
    message: `${userRepo}@${branch} received a new commit while the sync was running. Nothing was changed; retry the update.`,
  };
  if (currentHead !== headSha) return headMoved;
  let update;
  try {
    update = await ghFetch(`/repos/${userRepo}/git/refs/heads/${refPath(branch)}`, token, {
      method: "PATCH",
      body: { sha: commit.sha, force: false },
    });
  } catch {
    throw failFromStatus("update-branch", 0, null);
  }
  if (!update.ok) {
    if (update.status === 422 && /fast[- ]?forward/i.test(ghMessage(update.data))) {
      return headMoved;
    }
    throw failFromStatus("update-branch", update.status, update.data);
  }

  return {
    ok: true,
    upToDate: false,
    fromVersion,
    toVersion,
    commitSha: commit.sha,
    commitUrl: commit.html_url || `https://github.com/${userRepo}/commit/${commit.sha}`,
    pulled: cmp.total_commits,
    added: plan.writes.filter((w) => w.kind === "added").map((w) => w.path),
    modified: plan.writes.filter((w) => w.kind === "modified").map((w) => w.path),
    removed: plan.removals.map((r) => r.path),
    skipped: plan.skipped,
  };
}
