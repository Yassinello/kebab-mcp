/**
 * Edge-safe bootstrap rehydration for middleware.
 *
 * `first-run.ts` imports `node:fs` for the /tmp persistence layer, which
 * breaks when evaluated under Next's Edge runtime (middleware / proxy).
 * This module is a smaller, Edge-compatible subset: it reads the
 * first-run bootstrap directly from Upstash via the REST API, with no
 * file system access and no module-level state.
 *
 * The goal is to close the consistency gap where middleware would see
 * `process.env.MCP_AUTH_TOKEN` as undefined on a fresh lambda (because
 * the handler rehydrates from KV at request time, but the middleware
 * runs first and has no such path), leading to spurious
 * `/config` → `/welcome` redirects on a fully-initialized instance.
 *
 * Keep this file import-clean: only Web-standard APIs (`fetch`, `JSON`),
 * no Node built-ins, no `@/core/*` imports that might pull fs in
 * transitively.
 */

const KV_BOOTSTRAP_KEY = "mymcp:firstrun:bootstrap";

/**
 * If `process.env.MCP_AUTH_TOKEN` is missing on the current lambda and
 * Upstash is configured, fetch the persisted bootstrap and mutate
 * `process.env` so the middleware's auth logic sees a consistent view.
 * Swallows all errors — middleware must never break page serving.
 *
 * On warm lambdas the first check short-circuits, so the Upstash call
 * only fires once per lambda lifetime (or never, if the platform already
 * injected MCP_AUTH_TOKEN via real env vars).
 */
export async function ensureBootstrapRehydratedFromUpstash(): Promise<void> {
  if (process.env.MCP_AUTH_TOKEN) return;
  // Support both env var schemes: the legacy "Upstash for Vercel"
  // integration injects UPSTASH_REDIS_REST_URL/TOKEN, while the newer
  // Vercel Marketplace Upstash KV product injects KV_REST_API_URL/TOKEN.
  // Without this fallback, deploys via the marketplace flow silently
  // skip rehydrate even though Upstash IS configured — middleware then
  // sees no MCP_AUTH_TOKEN and redirects /config to /welcome.
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").trim();
  const token = (
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    ""
  ).trim();
  if (!url || !token) return;
  try {
    const endpoint = `${url.replace(/\/$/, "")}/get/${KV_BOOTSTRAP_KEY}`;
    const res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      // A second is plenty for a Redis GET on the same region; if it
      // takes longer than that, fall through to first-time-setup rather
      // than block the page.
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return;
    const json = (await res.json()) as { result?: string | null };
    if (!json.result) return;
    const parsed = JSON.parse(json.result) as {
      token?: unknown;
      claimId?: unknown;
      createdAt?: unknown;
    };
    if (typeof parsed.token !== "string" || parsed.token.length < 10) return;
    process.env.MCP_AUTH_TOKEN = parsed.token;
  } catch {
    // Network hiccup, malformed payload, timeout — any failure leaves
    // process.env as-is and the middleware proceeds with its existing
    // first-time-setup logic. Graceful degradation.
  }
}
