/**
 * Phase 69 / Plan 02 / Task 1 — per-account / per-tool KV-backed rate-limiter
 * for the Unipile connector.
 *
 * Sole export `checkUnipileRateLimit({ account_id, tool })` returns a
 * `RateLimitDecision` describing whether the next write would exceed a
 * day or week quota. It is the operator's safety net BEFORE the
 * LinkedIn server-side limiter triggers — silent over-sending = account
 * restrictions = lost business.
 *
 * Locked decisions (see .planning/phases/69-linkedin-writes/69-CONTEXT.md):
 *
 *  - D-38 — KV KEY FORMAT
 *      daily:  `unipile:ratelimit:<account_id>:<tool>:<YYYY-MM-DD>:daily`
 *      weekly: `unipile:ratelimit:<account_id>:<tool>:<YYYY-Www>:weekly`
 *    Auto-prefixed with `tenant:<id>:` by `TenantKVStore` via
 *    `getContextKVStore()` (D-18). No kv-allowlist entry needed.
 *
 *  - D-39 — DEFAULT CAPS (LinkedIn-realistic, env-overridable)
 *      send_connection: daily=25  weekly=100
 *      send_message:    daily=50  (no weekly cap)
 *      send_inmail:     daily=15  (no weekly cap)
 *    Overrides read via `getConfigInt()` at CALL TIME (not module load) so
 *    operators can flip caps without redeploying.
 *
 *  - D-40 — FAIL-CLOSED BY DEFAULT
 *      If `kv.incr()` throws OR the KVStore impl lacks `incr`, we return
 *      `{ blocked: true, reason: "kv_unavailable" }`. Security-correct for
 *      action quotas (per `feedback_defensive_defaults` — generous defaults
 *      apply to TIME like timeouts; security-critical limits must fail-CLOSED
 *      to avoid silent spam bursts).
 *      Opt-in escape hatch: `KEBAB_UNIPILE_RATELIMIT_FAIL_MODE=open`
 *      switches to fail-OPEN (still logged + reason="kv_unavailable").
 *
 *  - D-41 — RETURN-SHAPE CONTRACT
 *      `checkUnipileRateLimit` NEVER throws. All failure modes are encoded
 *      in the returned `RateLimitDecision`. Callers gate their write on
 *      `if (decision.blocked) return audit_error_rate_limit_kebab(decision)`.
 *
 * Window-reset semantics (RESEARCH §4.5):
 *  - daily cap hit  → `retry_after = next UTC midnight ISO`
 *  - weekly cap hit → `retry_after = next Monday 00:00 UTC ISO`
 *  - kv unavailable → `retry_after = now + 60s ISO` (transient retry hint)
 *
 * Anti-drift constraints:
 *  - Never `process.env.X` — config-facade is the single resolution point.
 *    (Enforced by ESLint rule `kebab/no-direct-process-env`.)
 *  - Never `getKVStore()` — always `getContextKVStore()` for tenant scope.
 *  - No `dualReadKV` migration shim (greenfield module).
 *  - No `sweepOldBuckets` (Upstash native TTL handles cleanup; ttlSeconds
 *    is set generously enough to outlast the bucket's own relevance).
 *  - No `KEBAB_RATE_LIMIT_INMEMORY` opt-in (per-account production quotas
 *    must not silently degrade to in-process counters that don't converge
 *    across warm lambdas).
 *
 * Wave 3 (Plan 06) retrofits `send_connection` to call this BEFORE the
 * send (per D-43 + D-49 — dedup-first, rate-limit-second per RESEARCH §4.6).
 * Wave 2 plans (03 send_message / 04 send_inmail) import it on first ship.
 */

import { getContextKVStore } from "@/core/request-context";
import { getConfig, getConfigInt } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";
import { getLogger } from "@/core/logging";

const log = getLogger("CONNECTOR:unipile");

export type UnipileRateLimitedTool =
  | "send_connection"
  | "send_message"
  | "send_inmail"
  // Spec v2 (ADR 0002)
  | "whatsapp_send"
  | "linkedin_post_engagement"
  | "linkedin_post"
  | "linkedin_cancel_invitation";

export interface RateLimitDecision {
  blocked: boolean;
  daily_used: number;
  daily_limit: number;
  weekly_used?: number;
  weekly_limit?: number;
  reason?: "daily_cap" | "weekly_cap" | "kv_unavailable";
  /** ISO-8601 timestamp of the next reset (daily midnight UTC, weekly Monday UTC, or now+60s for KV failure). */
  retry_after?: string;
}

// ── D-39: default caps + env-override names ────────────────────────────
//
// Read inside a function (not a module-level const) so env-var overrides
// are picked up at call time. Module-level reads would be a stale-cache
// hazard the operator-debugging story is allergic to (Plan 01 lesson).

export function getCaps(tool: UnipileRateLimitedTool): { daily: number; weekly: number | null } {
  switch (tool) {
    case "send_connection":
      return {
        daily: getConfigInt("KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP", 25),
        weekly: getConfigInt("KEBAB_UNIPILE_LINKEDIN_WEEKLY_CONNECT_CAP", 100),
      };
    case "send_message":
      return {
        daily: getConfigInt("KEBAB_UNIPILE_LINKEDIN_DAILY_DM_CAP", 50),
        weekly: null,
      };
    case "send_inmail":
      return {
        daily: getConfigInt("KEBAB_UNIPILE_LINKEDIN_DAILY_INMAIL_CAP", 15),
        weekly: null,
      };
    // Spec v2 (ADR 0002) — conservative defaults, env-overridable.
    case "whatsapp_send":
      return {
        daily: getConfigInt("KEBAB_UNIPILE_WHATSAPP_DAILY_SEND_CAP", 100),
        weekly: null,
      };
    case "linkedin_post_engagement":
      return {
        daily: getConfigInt("KEBAB_UNIPILE_LINKEDIN_DAILY_ENGAGEMENT_CAP", 40),
        weekly: null,
      };
    case "linkedin_post":
      return {
        daily: getConfigInt("KEBAB_UNIPILE_LINKEDIN_DAILY_POST_CAP", 3),
        weekly: null,
      };
    case "linkedin_cancel_invitation":
      return {
        daily: getConfigInt("KEBAB_UNIPILE_LINKEDIN_DAILY_WITHDRAW_CAP", 30),
        weekly: null,
      };
  }
}

// ── Bucket helpers (UTC, no library deps) ──────────────────────────────

/** YYYY-MM-DD in UTC. */
export function dailyBucket(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * ISO-8601 week label: `YYYY-Www`.
 *
 * Week starts Monday UTC. The year is the year of the week's Thursday
 * (so a Jan 1 that falls on Friday is week 53 of the previous year).
 * Matches `date-fns/getISOWeek` / Postgres `date_trunc('week', ...)`.
 */
export function isoWeekBucket(d: Date = new Date()): string {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = target.getUTCDay() || 7; // Sun = 7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum); // back to Thursday of week
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/** ISO-8601 timestamp of the next UTC midnight (00:00 UTC of tomorrow). */
export function nextUtcMidnight(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/** ISO-8601 timestamp of the next Monday 00:00 UTC (start of next ISO week). */
export function nextMondayUtc(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilMonday)
  ).toISOString();
}

/**
 * Atomically increment per-account / per-tool day + week counters and
 * return a `RateLimitDecision`.
 *
 * Contract (D-41): NEVER throws. KV failures are encoded as
 * `{ blocked: true, reason: "kv_unavailable" }` (fail-CLOSED default) or
 * `{ blocked: false, reason: "kv_unavailable" }` (escape-hatch fail-OPEN).
 *
 * Daily-cap-exceeded path intentionally does NOT touch the weekly
 * counter — avoids double-burning a write that won't happen anyway.
 */
export async function checkUnipileRateLimit(args: {
  account_id: string;
  tool: UnipileRateLimitedTool;
}): Promise<RateLimitDecision> {
  const { account_id, tool } = args;
  const caps = getCaps(tool);
  const dailyKey = `unipile:ratelimit:${account_id}:${tool}:${dailyBucket()}:daily`;
  const weeklyKey = `unipile:ratelimit:${account_id}:${tool}:${isoWeekBucket()}:weekly`;

  try {
    const kv = getContextKVStore();
    if (typeof kv.incr !== "function") {
      // KVStore impl without incr — fail-CLOSED default (D-40).
      throw new Error("KVStore.incr not implemented");
    }

    // TTL = 36h on daily, 9 days on weekly — generously outlasts the
    // bucket window so we never race with a UTC-midnight / Monday-UTC
    // rollover (Upstash native EXPIRE; FilesystemKV ignores TTL — dev only).
    const dailyCount = await kv.incr(dailyKey, { ttlSeconds: 36 * 3600 });
    if (dailyCount > caps.daily) {
      // Over daily cap — block. DO NOT touch weekly counter (avoids double-incr).
      return {
        blocked: true,
        daily_used: dailyCount,
        daily_limit: caps.daily,
        reason: "daily_cap",
        retry_after: nextUtcMidnight(),
      };
    }

    let weeklyUsed: number | undefined;
    if (caps.weekly !== null) {
      const weeklyCount = await kv.incr(weeklyKey, { ttlSeconds: 9 * 86_400 });
      weeklyUsed = weeklyCount;
      if (weeklyCount > caps.weekly) {
        return {
          blocked: true,
          daily_used: dailyCount,
          daily_limit: caps.daily,
          weekly_used: weeklyCount,
          weekly_limit: caps.weekly,
          reason: "weekly_cap",
          retry_after: nextMondayUtc(),
        };
      }
    }

    return {
      blocked: false,
      daily_used: dailyCount,
      daily_limit: caps.daily,
      ...(caps.weekly !== null ? { weekly_used: weeklyUsed ?? 0, weekly_limit: caps.weekly } : {}),
    };
  } catch (err) {
    log.warn("Rate-limiter KV failure", { account_id, tool, err: toMsg(err) });
    const failMode = getConfig("KEBAB_UNIPILE_RATELIMIT_FAIL_MODE");
    if (failMode === "open") {
      // D-40 escape hatch — fail-OPEN (logged, operator-visible).
      return {
        blocked: false,
        daily_used: 0,
        daily_limit: caps.daily,
        reason: "kv_unavailable",
      };
    }
    // DEFAULT: fail-CLOSED (D-40 — security-correct for action quotas).
    return {
      blocked: true,
      daily_used: 0,
      daily_limit: caps.daily,
      reason: "kv_unavailable",
      retry_after: new Date(Date.now() + 60_000).toISOString(),
    };
  }
}
