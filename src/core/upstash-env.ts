/**
 * Upstash credential env reader — DUR-06.
 *
 * Centralizes all reads of Upstash REST credentials. Supports both naming
 * variants in common deployment scenarios:
 *   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (manual Upstash setup)
 *   - KV_REST_API_URL / KV_REST_API_TOKEN (Vercel Marketplace Upstash KV)
 *
 * The 2026-04-20 session shipped a production bug caused by this naming
 * drift — the Vercel Marketplace Upstash integration injects KV_REST_API_*
 * while the codebase only read UPSTASH_REDIS_REST_*, so users who used the
 * one-click Marketplace setup ended up with a "no KV" deploy despite having
 * a Redis instance attached. This module makes that divergence impossible
 * going forward: every reader calls through `getUpstashCreds()`.
 *
 * Preference: UPSTASH_* over KV_* when both are set (explicit setup wins
 * over Marketplace default). The `source` field lets callers surface the
 * active naming variant in observability / UI hints if needed.
 *
 * Contract test `tests/contract/upstash-env-single-reader.test.ts`
 * enforces that no other `src/` or `app/` file reads these env vars
 * directly. `.env.example` documents both variants.
 */

export interface UpstashCreds {
  url: string;
  token: string;
  source: "upstash-redis" | "vercel-marketplace";
}

function read(key: string): string {
  return (process.env[key] || "").trim();
}

/**
 * Read Upstash credentials from process.env. Returns `null` if neither
 * naming variant is fully configured (both URL AND token must be set for
 * the same variant — half-configs return null).
 */
export function getUpstashCreds(): UpstashCreds | null {
  const upstashUrl = read("UPSTASH_REDIS_REST_URL");
  const upstashToken = read("UPSTASH_REDIS_REST_TOKEN");
  if (upstashUrl && upstashToken) {
    return { url: upstashUrl, token: upstashToken, source: "upstash-redis" };
  }

  const kvUrl = read("KV_REST_API_URL");
  const kvToken = read("KV_REST_API_TOKEN");
  if (kvUrl && kvToken) {
    return { url: kvUrl, token: kvToken, source: "vercel-marketplace" };
  }

  return null;
}

/**
 * Shape-only check: true iff `getUpstashCreds()` would return non-null.
 * Cheaper than the full getter when only the presence matters (e.g.
 * storage-mode detection, filesystem-vs-KV routing decisions).
 */
export function hasUpstashCreds(): boolean {
  return getUpstashCreds() !== null;
}
