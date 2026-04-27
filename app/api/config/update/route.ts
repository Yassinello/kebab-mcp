import { NextResponse } from "next/server";
import { execSync } from "node:child_process";
import {
  composeRequestPipeline,
  rehydrateStep,
  authStep,
  hydrateCredentialsStep,
} from "@/core/pipeline";
import type { PipelineContext } from "@/core/pipeline";
import { errorResponse } from "@/core/error-response";
import { getConfig } from "@/core/config-facade";
import { getKVStore } from "@/core/kv-store";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
import {
  computeUpdateStatus,
  ghFetch,
  resolveUpdateToken,
  UPDATE_CHECK_KV_KEY,
  UPDATE_CHECK_TTL_SECONDS,
  UPDATE_CHECK_STALE_MS,
  type UpdateStatusPayload,
} from "@/core/update-check";
import { UPSTREAM_OWNER, UPSTREAM_REPO_SLUG } from "../../../landing/deploy-url";

const updateCheckLogger = getLogger("config.update.cache");

/**
 * GET  /api/config/update → check if updates are available
 * POST /api/config/update → apply updates
 *
 * Three modes:
 *   "git"        — local dev / Docker: uses git CLI (existing path, unchanged)
 *   "github-api" — Vercel fork with VERCEL_GIT_REPO_OWNER + VERCEL_GIT_REPO_SLUG: uses GitHub REST API
 *   "disabled"   — Vercel without owner/slug, or KEBAB_DISABLE_UPDATE_API=1
 */

/**
 * Pipeline composition note (Phase 62, STAB-02):
 *   This route uses an EXPLICIT pipeline rather than the `withAdminAuth`
 *   HOC because it reads `KEBAB_UPDATE_PAT` / `GITHUB_TOKEN` via
 *   `getCredential()`. `withAdminAuth` does NOT include
 *   `hydrateCredentialsStep`, so a PAT saved via /api/config/env
 *   (which writes to `cred:*` KV) would be invisible here. We add
 *   `hydrateCredentialsStep` per-route — extending `withAdminAuth`
 *   itself was rejected (D-08): adds KV-read latency to 30+ admin
 *   routes that don't need credentials. Per-route opt-in is cleaner.
 *   See .planning/phases/062-stabilize-phase-61/062-CONTEXT.md.
 */

// ── Mode resolution ────────────────────────────────────────────────────

type UpdateMode = "git" | "github-api" | "disabled";

function resolveMode(): UpdateMode {
  if (getConfig("KEBAB_DISABLE_UPDATE_API") === "1") return "disabled";
  if (getConfig("VERCEL") === "1") {
    const owner = getConfig("VERCEL_GIT_REPO_OWNER");
    const slug = getConfig("VERCEL_GIT_REPO_SLUG");
    return owner && slug ? "github-api" : "disabled";
  }
  return "git";
}

// ── git-CLI helpers (existing path — zero changes) ─────────────────────

function run(cmd: string): { ok: boolean; out: string; err: string } {
  try {
    const out = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();
    return { ok: true, out, err: "" };
  } catch (err) {
    const e = err as { message?: string; stderr?: Buffer | string };
    const stderr = e.stderr ? e.stderr.toString().trim() : "";
    return { ok: false, out: "", err: stderr || e.message || String(err) };
  }
}

function resolveRemote(): { ok: true; remote: string } | { ok: false; error: string } {
  const inside = run("git rev-parse --is-inside-work-tree");
  if (!inside.ok || inside.out !== "true") {
    return { ok: false, error: "Not a git work tree." };
  }
  const remotes = run("git remote");
  if (!remotes.ok) return { ok: false, error: "git remote failed." };
  const list = remotes.out.split(/\s+/).filter(Boolean);
  if (list.includes("upstream")) return { ok: true, remote: "upstream" };
  if (list.includes("origin")) return { ok: true, remote: "origin" };
  return { ok: false, error: "No upstream or origin remote configured." };
}

// ── GitHub API GET handler ─────────────────────────────────────────────
//
// GitHub Compare + breaking detection + ghFetch helper now live in
// src/core/update-check.ts so the daily cron route (Phase 63 Plan 02) can
// share the exact same logic. This route imports `computeUpdateStatus`
// for GET and `ghFetch` for the POST merge-upstream path.

/**
 * Validate that a parsed cache value has the minimum shape we expect.
 * Anything missing checkedAt or mode is treated as corrupt → cache-miss.
 */
function isValidCachedPayload(p: unknown): p is UpdateStatusPayload {
  if (!p || typeof p !== "object") return false;
  const obj = p as Record<string, unknown>;
  return (
    typeof obj.checkedAt === "string" &&
    obj.mode === "github-api" &&
    typeof obj.status === "string" &&
    typeof obj.behind_by === "number" &&
    typeof obj.ahead_by === "number"
  );
}

async function githubApiGetHandler(forceRefresh: boolean): Promise<Response> {
  const owner = getConfig("VERCEL_GIT_REPO_OWNER")!;
  const slug = getConfig("VERCEL_GIT_REPO_SLUG")!;

  const token = resolveUpdateToken();

  if (!token) {
    return NextResponse.json({
      mode: "github-api",
      available: false,
      reason: "no-token",
      configureUrl: "/config?tab=settings&sub=advanced",
      tokenConfigured: false,
    });
  }

  // Cache-first read (CRON-02): consult `global:update-check` before live
  // call. ?force=1 bypasses cache entirely (used by Refresh button —
  // Plan 063-03). Stale (>48h checkedAt) is treated as a cache miss and
  // refetched. KV failures are non-fatal — log and fall through to live.
  if (!forceRefresh) {
    try {
      const kv = getKVStore();
      const cached = await kv.get(UPDATE_CHECK_KV_KEY);
      if (cached) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(cached);
        } catch {
          // Corrupt JSON — purge so the next caller doesn't keep falling through.
          await kv.delete(UPDATE_CHECK_KV_KEY).catch(() => {});
        }
        if (isValidCachedPayload(parsed)) {
          const checkedAtMs = Date.parse(parsed.checkedAt);
          const ageMs = Date.now() - checkedAtMs;
          if (Number.isFinite(checkedAtMs) && ageMs >= 0 && ageMs < UPDATE_CHECK_STALE_MS) {
            // Fresh cache hit — return immediately, no GitHub call.
            return NextResponse.json(parsed);
          }
          // Stale — fall through to live call.
        } else if (parsed !== null) {
          // Schema-mismatched (old version, missing fields) — purge.
          await kv.delete(UPDATE_CHECK_KV_KEY).catch(() => {});
        }
      }
    } catch (err) {
      // KV failure is non-fatal — log and fall through to live call.
      updateCheckLogger.warn("KV read failed, falling through to live call", {
        error: toMsg(err),
      });
    }
  }

  // Delegate to the shared compute helper. The helper does NOT touch KV,
  // auth, or credential hydration — that's the caller's job above.
  const result = await computeUpdateStatus(token, owner, slug);

  if (!result.ok) {
    // Invalidate the cache on auth/fetch error so the user isn't served
    // a stale "everything's fine" payload while their PAT is broken.
    try {
      const kv = getKVStore();
      await kv.delete(UPDATE_CHECK_KV_KEY);
    } catch {
      /* non-fatal */
    }
    if (result.kind === "auth") {
      return NextResponse.json({
        mode: "github-api",
        available: false,
        reason: "auth",
        tokenConfigured: true,
      });
    }
    if (result.kind === "not-a-fork") {
      // Deploy was created from a one-click flow (e.g. legacy /new/clone)
      // and the resulting repo is a standalone snapshot, not a real fork
      // of upstream. The merge-upstream API will reject — surface a clear,
      // actionable message pointing the user at the /deploy hub for the
      // recommended fork-then-import flow.
      return NextResponse.json({
        mode: "github-api",
        available: false,
        reason: "not-a-fork",
        tokenConfigured: true,
        deployedRepo: result.deployedRepo,
        upstreamRepo: `${UPSTREAM_OWNER}/${UPSTREAM_REPO_SLUG}`,
        redeployUrl: "/deploy",
      });
    }
    return errorResponse(new Error(`GitHub API failed: ${result.status}`), {
      status: 502,
      route: "config/update",
    });
  }

  // Write-back to KV with 48h TTL. Awaited — fire-and-forget banned
  // (CLAUDE.md, BUG-07). KV write failures are non-fatal — log and serve
  // the live response anyway.
  try {
    const kv = getKVStore();
    await kv.set(UPDATE_CHECK_KV_KEY, JSON.stringify(result.payload), UPDATE_CHECK_TTL_SECONDS);
  } catch (err) {
    updateCheckLogger.warn("KV write failed", {
      error: toMsg(err),
    });
  }

  // payload already carries `mode: "github-api"` and `checkedAt` (additive,
  // non-breaking — pre-Phase-63 callers ignore unknown fields).
  return NextResponse.json(result.payload);
}

// ── GitHub API POST handler ────────────────────────────────────────────

async function githubApiPostHandler(): Promise<Response> {
  const owner = getConfig("VERCEL_GIT_REPO_OWNER")!;
  const slug = getConfig("VERCEL_GIT_REPO_SLUG")!;

  const token = resolveUpdateToken();

  if (!token) {
    return NextResponse.json({ ok: false, reason: "no-token" }, { status: 400 });
  }

  // Server-side guard: re-check ahead_by before merge (D-04)
  // BASE=upstream, HEAD=fork → ahead_by>0 means fork has local commits → block merge
  const upstream = `${UPSTREAM_OWNER}:${UPSTREAM_REPO_SLUG}:main`;
  const compareRes = await ghFetch(`/repos/${owner}/${slug}/compare/${upstream}...main`, token);
  if (!compareRes.ok) {
    return errorResponse(new Error(`Pre-merge compare failed: ${compareRes.status}`), {
      status: 502,
      route: "config/update",
    });
  }
  const cmp = compareRes.data as { ahead_by: number; behind_by: number; html_url: string };
  if (cmp.ahead_by > 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: "diverged",
        resolveUrl: `https://github.com/${owner}/${slug}/compare/main...${UPSTREAM_OWNER}:${UPSTREAM_REPO_SLUG}:main`,
      },
      { status: 409 }
    );
  }
  if (cmp.behind_by === 0) {
    return NextResponse.json({ ok: true, pulled: 0, reason: "Already up to date." });
  }

  // Perform merge-upstream
  const mergeRes = await ghFetch(`/repos/${owner}/${slug}/merge-upstream`, token, {
    method: "POST",
    body: { branch: "main" },
  });

  if (mergeRes.status === 409) {
    const ghMsg = (mergeRes.data as { message?: string })?.message ?? "Conflict";
    return NextResponse.json(
      {
        ok: false,
        reason: "conflict",
        message: ghMsg,
        resolveUrl: `https://github.com/${owner}/${slug}/compare/main...${UPSTREAM_OWNER}:${UPSTREAM_REPO_SLUG}:main`,
      },
      { status: 409 }
    );
  }
  if (mergeRes.status === 401 || mergeRes.status === 403) {
    const ghMsg = (mergeRes.data as { message?: string })?.message ?? "Auth error";
    return NextResponse.json({ ok: false, reason: "auth", message: ghMsg }, { status: 403 });
  }
  if (mergeRes.status === 422) {
    return NextResponse.json(
      {
        ok: false,
        reason: "not-a-fork",
        message: "Repository may not be a GitHub fork. Use the GitHub UI to sync manually.",
      },
      { status: 422 }
    );
  }
  if (!mergeRes.ok) {
    return errorResponse(new Error(`merge-upstream failed: ${mergeRes.status}`), {
      status: 502,
      route: "config/update",
    });
  }

  const mergeData = mergeRes.data as { merge_type?: string };
  const deployUrl = `https://vercel.com/${owner}/${slug}/deployments`;

  return NextResponse.json({
    ok: true,
    pulled: cmp.behind_by,
    merge_type: mergeData.merge_type ?? "fast-forward",
    deployUrl,
  });
}

// ── GET handler ────────────────────────────────────────────────────────

async function getHandler(ctx: PipelineContext) {
  const mode = resolveMode();
  if (mode === "disabled") {
    return NextResponse.json({
      available: false,
      behind: 0,
      remote: "",
      disabled: "Updates disabled.",
    });
  }
  if (mode === "github-api") {
    // CRON-02: ?force=1 bypasses the KV cache and always refreshes from
    // GitHub, then writes back. Used by the dashboard's Refresh button.
    const url = new URL(ctx.request.url);
    const forceRefresh = url.searchParams.get("force") === "1";
    return githubApiGetHandler(forceRefresh);
  }

  // ── git-CLI path (non-Vercel) — unchanged ─────────────────────────

  const remoteRes = resolveRemote();
  if (!remoteRes.ok) {
    return NextResponse.json({
      available: false,
      behind: 0,
      remote: "",
      disabled: remoteRes.error,
    });
  }
  const { remote } = remoteRes;

  const fetch = run(`git fetch ${remote} main --quiet`);
  if (!fetch.ok) {
    return NextResponse.json({
      available: false,
      behind: 0,
      remote,
      disabled: `git fetch ${remote} failed: ${fetch.err.split("\n")[0]}`,
    });
  }

  const behind = run(`git rev-list --count HEAD..${remote}/main`);
  const ahead = run(`git rev-list --count ${remote}/main..HEAD`);
  const latest = run(`git rev-parse ${remote}/main`);

  const behindCount = behind.ok ? Number(behind.out) : 0;
  const aheadCount = ahead.ok ? Number(ahead.out) : 0;

  return NextResponse.json({
    available: behindCount > 0,
    behind: behindCount,
    ahead: aheadCount,
    remote,
    latest: latest.ok ? latest.out.slice(0, 7) : null,
  });
}

// ── POST handler ───────────────────────────────────────────────────────

async function postHandler() {
  const mode = resolveMode();
  if (mode === "disabled")
    return NextResponse.json({ ok: false, reason: "Updates disabled." }, { status: 403 });
  if (mode === "github-api") return githubApiPostHandler();

  // ── git-CLI path (non-Vercel) — unchanged ─────────────────────────

  const remoteRes = resolveRemote();
  if (!remoteRes.ok) {
    return NextResponse.json({ ok: false, reason: remoteRes.error }, { status: 400 });
  }
  const { remote } = remoteRes;

  // Refuse if local has uncommitted changes or diverged commits
  const status = run("git status --porcelain");
  if (status.ok && status.out.length > 0) {
    return NextResponse.json(
      { ok: false, reason: "Uncommitted local changes — commit or stash first." },
      { status: 409 }
    );
  }

  const fetch = run(`git fetch ${remote} main --quiet`);
  if (!fetch.ok) {
    return NextResponse.json(
      { ok: false, reason: `git fetch failed: ${fetch.err.split("\n")[0]}` },
      { status: 502 }
    );
  }

  const ahead = run(`git rev-list --count ${remote}/main..HEAD`);
  if (ahead.ok && Number(ahead.out) > 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: `${ahead.out} local commits ahead of ${remote}/main — resolve manually with 'git merge ${remote}/main'.`,
      },
      { status: 409 }
    );
  }

  const behind = run(`git rev-list --count HEAD..${remote}/main`);
  const pulled = behind.ok ? Number(behind.out) : 0;

  if (pulled === 0) {
    return NextResponse.json({ ok: true, pulled: 0, reason: "Already up to date." });
  }

  const merge = run(`git merge --ff-only ${remote}/main`);
  if (!merge.ok) {
    // P1 fold-in: wrap the git-shell error in the canonical 500 shape.
    // Server log retains the full (sanitized) merge.err for correlation;
    // the client sees only `{ error, errorId, hint }`.
    return errorResponse(new Error(`Merge failed: ${merge.err}`), {
      status: 500,
      route: "config/update",
    });
  }

  return NextResponse.json({
    ok: true,
    pulled,
    remote,
    note: "Merged. Restart the dev server to load new code (Next.js auto-reloads most changes).",
  });
}

export const GET = composeRequestPipeline(
  [rehydrateStep, authStep("admin"), hydrateCredentialsStep],
  getHandler
);
export const POST = composeRequestPipeline(
  [rehydrateStep, authStep("admin"), hydrateCredentialsStep],
  postHandler
);
