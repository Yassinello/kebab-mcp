import { NextResponse } from "next/server";
import {
  composeRequestPipeline,
  rehydrateStep,
  authStep,
  rateLimitStep,
  hydrateCredentialsStep,
  type PipelineContext,
} from "@/core/pipeline";
import { getConfig } from "@/core/config-facade";
import { getKVStore } from "@/core/kv-store";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
import { computeDeploymentUpdateStatus } from "@/core/release-sync";
import {
  resolveUpdateToken,
  UPDATE_CHECK_KV_KEY,
  UPDATE_CHECK_LOCK_KEY,
  UPDATE_CHECK_LOCK_TTL_SECONDS,
  UPDATE_CHECK_TTL_SECONDS,
} from "@/core/update-check";
import {
  fetchLatestUpstreamRelease,
  UPSTREAM_RELEASE_KV_KEY,
  UPSTREAM_RELEASE_TTL_SECONDS,
} from "@/core/upstream-release";

/**
 * Daily cron at 8h UTC (vercel.json).
 *
 * Calls computeDeploymentUpdateStatus() (fork or release-sync) against upstream and writes the
 * result to KV `global:update-check` with a 48h TTL. Without a token it only
 * refreshes `global:upstream-release` (anonymous read of the latest release). The Overview banner
 * reads this cache first (Plan 063-01) so warm pageviews don't pay the
 * 200-500ms GitHub round-trip.
 *
 * Pipeline (canonical Phase-41 cron, mirrors /api/cron/health):
 *   rehydrateStep        — populates bootstrap auth cache from KV (also
 *                          satisfies the route-rehydrate-coverage contract,
 *                          so no BOOTSTRAP_EXEMPT marker is needed).
 *   authStep("cron")     — enforces Authorization: Bearer ${CRON_SECRET}.
 *                          Mismatch → 401. Unset → 503 (unless loopback).
 *   rateLimitStep        — 120 req/min keyed by sha256(CRON_SECRET).
 *   hydrateCredentialsStep — D-15: PAT-via-Settings reaches the cron.
 *
 * Anti-stampede: a 60s SETNX lock guards against overlapping cron triggers
 * (rare, but possible if a previous run is slow). If the lock is held,
 * the run skips silently — the in-flight call will refresh the cache.
 */
const logger = getLogger("cron.update-check");

async function cronUpdateCheckHandler(_ctx: PipelineContext): Promise<Response> {
  // ── Resolve PAT (D-06: KEBAB_UPDATE_PAT first, then GITHUB_TOKEN) ──────
  const token = resolveUpdateToken();

  if (!token) {
    // UPD-11: without a token, still refresh the anonymous "latest upstream
    // release" cache, so the dashboard can say a new version is out.
    const latest = await fetchLatestUpstreamRelease();
    if (latest) {
      try {
        await getKVStore().set(
          UPSTREAM_RELEASE_KV_KEY,
          JSON.stringify(latest),
          UPSTREAM_RELEASE_TTL_SECONDS
        );
      } catch (err) {
        logger.warn("upstream release cache write failed", { error: toMsg(err) });
      }
    }
    logger.info("no token configured — refreshed the latest upstream release only", {
      latest: latest?.version ?? null,
    });
    return NextResponse.json({
      ok: false,
      reason: "no-token",
      latestVersion: latest?.version ?? null,
    });
  }

  // ── Determine fork owner/slug (Vercel-deployed forks) ──────────────────
  const owner = getConfig("VERCEL_GIT_REPO_OWNER");
  const slug = getConfig("VERCEL_GIT_REPO_SLUG");
  if (!owner || !slug) {
    logger.info("VERCEL_GIT_REPO_OWNER/SLUG unset — skipping (not a Vercel fork)");
    return NextResponse.json({ ok: false, reason: "not-a-fork" });
  }

  // ── Anti-stampede lock (60s) ───────────────────────────────────────────
  const kv = getKVStore();
  if (typeof kv.setIfNotExists === "function") {
    const lockResult = await kv.setIfNotExists(UPDATE_CHECK_LOCK_KEY, "1", {
      ttlSeconds: UPDATE_CHECK_LOCK_TTL_SECONDS,
    });
    if (!lockResult.ok) {
      logger.info("another update-check run holds the lock — skipping");
      return NextResponse.json({ ok: false, reason: "locked" });
    }
  }

  // ── Shared status helper: fork → merge-upstream, else release-sync ─────
  const result = await computeDeploymentUpdateStatus(token, owner, slug);
  if (!result.ok) {
    logger.warn("update status check failed", { kind: result.kind });
    // Invalidate stale cache so the next dashboard hit retries live.
    await kv.delete(UPDATE_CHECK_KV_KEY).catch(() => {});
    return NextResponse.json({ ok: false, reason: result.kind });
  }

  // ── Awaited KV write (CLAUDE.md fire-and-forget rule + BUG-07) ─────────
  try {
    await kv.set(UPDATE_CHECK_KV_KEY, JSON.stringify(result.payload), UPDATE_CHECK_TTL_SECONDS);
    logger.info("update-check cache refreshed", {
      status: result.payload.status,
      behind_by: result.payload.behind_by,
    });
  } catch (err) {
    logger.error("KV write failed", { error: toMsg(err) });
    return NextResponse.json({ ok: false, reason: "kv-write-failed" }, { status: 502 });
  }

  return NextResponse.json({ ok: true, payload: result.payload });
}

export const GET = composeRequestPipeline(
  [
    rehydrateStep,
    authStep("cron"),
    rateLimitStep({ scope: "cron", keyFrom: "cronSecretTokenId", limit: 120 }),
    hydrateCredentialsStep,
  ],
  cronUpdateCheckHandler
);
