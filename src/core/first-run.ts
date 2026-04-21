/**
 * First-run / zero-config bootstrap for Vercel deploys.
 *
 * Problem: We want users to click "Deploy to Vercel" with NO env vars
 * pre-filled, then land on /welcome to generate their auth token. But Vercel
 * serverless does not hot-reload env vars — even writing via the REST API
 * only takes effect on the next cold start.
 *
 * Solution (in-memory bridge):
 * 1. The first browser to POST /api/welcome/claim gets a signed cookie
 *    representing a "claim" on this instance. Only the claimer can later
 *    initialize the token.
 * 2. On init, we generate a 32-byte hex token, mutate process.env so the
 *    current Node instance sees it immediately, AND persist a small JSON
 *    descriptor to /tmp (per-instance, ~15min). Subsequent requests on the
 *    same warm instance work seamlessly.
 * 3. Cold starts re-hydrate from /tmp if the file is still present. Once the
 *    user has manually pasted the token into Vercel and triggered a redeploy,
 *    process.env.MCP_AUTH_TOKEN is set "for real" and the bootstrap state is
 *    cleared.
 *
 * This module is the single source of truth for first-run state.
 *
 * v0.11 Phase 41 (T20 fold-in): rehydrate is no longer triggered at
 * module load. The previous `rehydrateBootstrapFromTmp();` line at the
 * bottom of this file made test order depend on a disk-I/O side effect
 * (ARCH-AUDIT §3 / POST-V0.10-AUDIT §B.7). The composable request
 * pipeline's `rehydrateStep` (src/core/pipeline/rehydrate-step.ts) is
 * now the single deterministic entry point — every request-handling
 * path rehydrates exactly once at the pipeline boundary via
 * `rehydrateBootstrapAsync()`, and `withBootstrapRehydrate` remains a
 * valid backwards-compat wrapper for routes that haven't migrated.
 * This module is therefore SIDE-EFFECT FREE at module load.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKVStore } from "./kv-store";
import {
  getSigningSecret,
  rotateSigningSecret,
  SigningSecretUnavailableError,
} from "./signing-secret";
import { hasUpstashCreds } from "./upstash-env";
import { getLogger } from "./logging";
import { withSpan } from "./tracing";

const firstRunLog = getLogger("FIRST-RUN");
// Note: the v0.10 tenant-prefix migration trigger lives in
// `src/core/with-bootstrap-rehydrate.ts` (DUR-02). See the docstring on
// `rehydrateBootstrapAsync` below for the rationale.

const KV_BOOTSTRAP_KEY = "mymcp:firstrun:bootstrap";

// OBS-01 / OBS-02: rehydrate observability metadata. Persisted to KV so
// /api/admin/status can diagnose cold-start health without tailing
// Vercel logs. "last" = ISO timestamp of most-recent successful rehydrate;
// "count" = { total, events: [{at}] } with 24h sliding window.
const REHYDRATE_META_LAST_KEY = "mymcp:firstrun:rehydrate-meta:last";
const REHYDRATE_COUNT_KV_KEY = "mymcp:firstrun:rehydrate-count";

export const FIRST_RUN_COOKIE_NAME = "mymcp_firstrun_claim";
export const CLAIM_TTL_MS = 30 * 60 * 1000; // 30 minutes
const BOOTSTRAP_TTL_MS = 15 * 60 * 1000; // 15 minutes (Vercel /tmp lifetime)
const BOOTSTRAP_PATH = join(tmpdir(), ".mymcp-bootstrap.json");

interface ClaimRecord {
  createdAt: number;
}

interface BootstrapPayload {
  claimId: string;
  token: string;
  createdAt: number;
}

// Module-level state. Reset on cold start; hydrated from /tmp where possible.
const claims = new Map<string, ClaimRecord>();
let activeBootstrap: BootstrapPayload | null = null;

/**
 * SEC-02: in-memory mirror of the minted MCP_AUTH_TOKEN. Replaces the
 * pre-v0.10 practice of mutating `process.env.MCP_AUTH_TOKEN` at
 * request time, which was racy on warm lambdas. `checkMcpAuth` consults
 * this cache via `getBootstrapAuthToken()` before falling back to the
 * boot-time env snapshot.
 */
let bootstrapAuthTokenCache: string | null = null;

/**
 * Returns the in-memory bootstrap auth token, if any. Consumed by
 * `checkMcpAuth` so a bootstrap-minted token is recognized on the
 * current warm lambda without mutating global state.
 */
export function getBootstrapAuthToken(): string | null {
  return bootstrapAuthTokenCache;
}

/**
 * KV is OPTIONAL. The factory in kv-store.ts always returns *something*
 * (filesystem fallback) but for cross-instance persistence we only want
 * a backend that's actually shared across instances. On Vercel without
 * Upstash, the kv-store fallback is /tmp — which gives no benefit over
 * the bootstrap /tmp file we already write. So we skip mirroring there.
 * Off-Vercel we mirror to ./data/kv.json (genuinely durable + shared).
 */
function isExternalKvAvailable(): boolean {
  if (hasUpstashCreds()) return true;
  if (process.env.VERCEL !== "1") return true;
  return false;
}

// DUR-04: `persistBootstrapToKv(...)` (fire-and-forget KV writer) was
// removed along with its sole caller in `bootstrapToken()`. The
// authoritative cross-instance persistence is `flushBootstrapToKv()`
// below, which route handlers await before responding so the lambda
// reaper cannot kill the write mid-flight.

async function loadBootstrapFromKv(): Promise<BootstrapPayload | null> {
  if (!isExternalKvAvailable()) return null;
  try {
    const kv = getKVStore();
    const raw = await kv.get(KV_BOOTSTRAP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BootstrapPayload;
    if (!parsed?.claimId || !parsed?.token || !parsed?.createdAt) return null;
    // No TTL check: KV is durable, unlike /tmp. The BOOTSTRAP_TTL_MS was
    // sized to match Vercel's /tmp container lifetime (~15 min), which
    // makes sense there but would punish any cold lambda that wakes up
    // >15 min after the user minted their token — the KV bootstrap is
    // the authoritative, permanent record of "this instance is set up"
    // on no-auto-magic deploys, and we want it to restore
    // `process.env.MCP_AUTH_TOKEN` regardless of age. forceReset() is
    // the explicit path for invalidating a bootstrap (delete /tmp +
    // delete KV key + clear in-memory state).
    return parsed;
  } catch (err) {
    console.info(
      `[Kebab MCP first-run] KV load skipped: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

async function deleteBootstrapFromKv(): Promise<void> {
  if (!isExternalKvAvailable()) return;
  try {
    const kv = getKVStore();
    await kv.delete(KV_BOOTSTRAP_KEY);
  } catch (err) {
    console.info(
      `[Kebab MCP first-run] KV delete skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function sign(value: string): Promise<string> {
  const secret = await getSigningSecret();
  return createHmac("sha256", secret).update(value).digest("hex");
}

function safeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

async function encodeCookie(claimId: string): Promise<string> {
  return `${claimId}.${await sign(claimId)}`;
}

async function decodeCookie(raw: string): Promise<string | null> {
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const claimId = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!claimId || !sig) return null;
  if (!safeEqHex(sig, await sign(claimId))) return null;
  return claimId;
}

async function readClaimCookie(request: Request): Promise<string | null> {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  const re = new RegExp(`(?:^|;\\s*)${FIRST_RUN_COOKIE_NAME}=([^;]+)`);
  const m = cookieHeader.match(re);
  if (!m) return null;
  return decodeCookie(decodeURIComponent(m[1]));
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, rec] of claims.entries()) {
    if (now - rec.createdAt > CLAIM_TTL_MS) claims.delete(id);
  }
  if (activeBootstrap && Date.now() - activeBootstrap.createdAt > BOOTSTRAP_TTL_MS) {
    activeBootstrap = null;
  }
}

/** True when this instance is operating without a real MCP_AUTH_TOKEN. */
export function isFirstRunMode(): boolean {
  // Either the boot env has the token (permanent), or the in-memory
  // bootstrap cache has it (transient, this warm lambda), or we really
  // are in first-run mode.
  return !process.env.MCP_AUTH_TOKEN && !bootstrapAuthTokenCache;
}

/** True when MCP_AUTH_TOKEN comes from our in-memory bootstrap, not Vercel env. */
export function isBootstrapActive(): boolean {
  pruneExpired();
  return activeBootstrap !== null;
}

export interface ClaimResult {
  claimId: string;
  isNewClaim: boolean;
  isClaimer: boolean;
  cookieToSet?: string;
}

/**
 * Get the existing claim (if the request carries a valid claim cookie) or
 * create a new one. Only ONE active claim is allowed at a time — first writer
 * wins, second visitor is told the instance is locked.
 *
 * Async as of v0.10 (SEC-04): the HMAC signing secret is now KV-persisted
 * and read at verify/mint time.
 */
export async function getOrCreateClaim(request: Request): Promise<ClaimResult> {
  pruneExpired();

  const existingId = await readClaimCookie(request);
  if (existingId && claims.has(existingId)) {
    return { claimId: existingId, isNewClaim: false, isClaimer: true };
  }

  // Cookie present but no in-memory record (cold start). If the bootstrap
  // /tmp file matches, treat them as the claimer.
  if (existingId && activeBootstrap?.claimId === existingId) {
    return { claimId: existingId, isNewClaim: false, isClaimer: true };
  }

  // If another claim is already active and unexpired, refuse to mint another.
  if (claims.size > 0) {
    const otherId = claims.keys().next().value as string;
    return { claimId: otherId, isNewClaim: false, isClaimer: false };
  }

  const claimId = randomBytes(32).toString("hex");
  claims.set(claimId, { createdAt: Date.now() });
  console.info(`[Kebab MCP first-run] new claim minted (id=${claimId.slice(0, 8)}…)`);
  return {
    claimId,
    isNewClaim: true,
    isClaimer: true,
    cookieToSet: await encodeCookie(claimId),
  };
}

/**
 * True if the request carries a valid first-run claim cookie.
 *
 * As of v0.10 (SEC-04) the cookie is HMAC-signed with a random 32-byte
 * secret persisted in KV at `mymcp:firstrun:signing-secret`. A valid
 * signature is proof the bearer received the cookie from
 * `/api/welcome/claim` on this deployment. The in-memory `claims` Map and
 * `activeBootstrap` are hot-path hints — on serverless platforms without
 * Upstash, cold lambdas have neither, and the original "must match
 * in-memory state" check would reject every cross-lambda welcome call
 * with 403. "First writer wins" is still enforced at cookie issuance
 * time by `getOrCreateClaim`.
 *
 * Rotation: `MYMCP_RECOVERY_RESET=1` now rotates the signing secret via
 * `rotateSigningSecret()` (called from `rehydrateBootstrapFromTmp`), so
 * any pre-reset cookies no longer verify. This closes SEC-05.
 *
 * Async as of v0.10 because the signing secret is KV-backed.
 */
export async function isClaimer(request: Request): Promise<boolean> {
  pruneExpired();
  return (await readClaimCookie(request)) !== null;
}

/**
 * Generate the user's permanent token, mutate process.env, persist to /tmp.
 * Idempotent: calling twice with the same claimId returns the existing token.
 *
 * KV persistence is fire-and-forget here so the function stays sync for
 * test callers. Production code paths that need cross-lambda durability
 * (the welcome init endpoint) MUST also call `flushBootstrapToKv()` and
 * await it before returning the response — otherwise Vercel reaps the
 * lambda after the response is sent and the in-flight Upstash SET is
 * cancelled mid-write, leaving the KV bootstrap key empty and every
 * cold lambda after that thinking the instance is uninitialized.
 */
export function bootstrapToken(claimId: string): { token: string } {
  pruneExpired();

  if (activeBootstrap?.claimId === claimId) {
    return { token: activeBootstrap.token };
  }

  const token = randomBytes(32).toString("hex");
  // SEC-02: store in module-scope cache instead of process.env so
  // concurrent requests don't observe mid-write torn state. The
  // transport's checkMcpAuth consults getBootstrapAuthToken() before
  // the boot-env snapshot.
  bootstrapAuthTokenCache = token;

  activeBootstrap = { claimId, token, createdAt: Date.now() };

  let persisted = false;
  // silent-swallow-ok: /tmp may be read-only in some containers (Fly, Cloud Run sandbox); /tmp is a warm-path optimization — in-memory cache + KV are the authoritative state
  try {
    writeFileSync(BOOTSTRAP_PATH, JSON.stringify(activeBootstrap), { encoding: "utf-8" });
    persisted = true;
  } catch {
    // Read-only filesystem — fall back to in-memory + KV.
  }

  // DUR-04: the previous `void persistBootstrapToKv(activeBootstrap)`
  // here was the root cause of one of the 2026-04-20 session's bugs —
  // Vercel's lambda reaper killed the fire-and-forget write before it
  // landed in Upstash. The authoritative cross-instance persistence is
  // `flushBootstrapToKv()`, awaited by welcome/init before responding
  // (see app/api/welcome/init/route.ts). Keeping a parallel fire-and-
  // forget call here added nothing and reliably lost the race.

  console.info(
    `[Kebab MCP first-run] bootstrap token minted (claim=${claimId.slice(0, 8)}…, persisted=${persisted})`
  );
  return { token };
}

/**
 * Synchronously-callable counterpart that production endpoints await
 * after `bootstrapToken()` so the KV write is durable before the lambda
 * is reaped. No-op when there's nothing to persist (e.g. test paths
 * without an active bootstrap).
 *
 * Unlike the fire-and-forget `persistBootstrapToKv` inside
 * `bootstrapToken()`, this variant propagates failures — if the Upstash
 * SET itself fails (rate limit, auth error, network), the caller gets a
 * thrown error instead of silent "welcome looked fine, but /api/mcp
 * returns 503 forever". Init surfaces this to the UI as a visible
 * failure so the user can retry rather than save a doomed token.
 */
export async function flushBootstrapToKv(): Promise<void> {
  if (!activeBootstrap) return;
  if (!isExternalKvAvailable()) return;
  const kv = getKVStore();
  await kv.set(KV_BOOTSTRAP_KEY, JSON.stringify(activeBootstrap));
}

/**
 * Force-clear all bootstrap state (in-memory + on-disk). Distinct from
 * clearBootstrap() in that it logs loudly — used by the recovery escape hatch.
 */
export function forceReset(): void {
  activeBootstrap = null;
  bootstrapAuthTokenCache = null;
  claims.clear();
  // silent-swallow-ok: recovery-reset cleanup; missing /tmp file is the success case, not a failure
  try {
    if (existsSync(BOOTSTRAP_PATH)) unlinkSync(BOOTSTRAP_PATH);
  } catch {
    // Best-effort unlink.
  }
  // fire-and-forget OK: recovery cleanup of KV bootstrap key; caller does not depend on KV ack
  void deleteBootstrapFromKv();
  console.info("[Kebab MCP first-run] forceReset() called — bootstrap state cleared");
}

/** Re-hydrate bootstrap state from /tmp on cold start. Called at module load. */
export function rehydrateBootstrapFromTmp(): void {
  if (process.env.MYMCP_RECOVERY_RESET === "1") {
    forceReset();
    // SEC-05: rotate the signing secret so pre-reset claim cookies no
    // longer verify.
    // fire-and-forget OK: recovery reset; signing-secret rotation is idempotent and safe to retry
    void rotateSigningSecret().catch((err: unknown) => {
      console.info(
        `[Kebab MCP first-run] rotateSigningSecret skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    console.warn(
      "[Kebab MCP first-run] MYMCP_RECOVERY_RESET=1 detected — bootstrap reset and signing secret rotated. Remove the env var after recovery."
    );
    return;
  }
  // silent-swallow-ok: a malformed or missing /tmp bootstrap is a normal cold-start / first-run state; caller proceeds to KV rehydrate
  try {
    if (!existsSync(BOOTSTRAP_PATH)) return;
    const raw = readFileSync(BOOTSTRAP_PATH, "utf-8");
    const parsed = JSON.parse(raw) as BootstrapPayload;
    if (!parsed?.claimId || !parsed?.token || !parsed?.createdAt) return;
    if (Date.now() - parsed.createdAt > BOOTSTRAP_TTL_MS) return;
    activeBootstrap = parsed;
    claims.set(parsed.claimId, { createdAt: parsed.createdAt });
    if (!process.env.MCP_AUTH_TOKEN) {
      // SEC-02: populate the in-memory cache, NOT process.env.
      bootstrapAuthTokenCache = parsed.token;
    }
    console.info(
      `[Kebab MCP first-run] re-hydrated bootstrap from /tmp (claim=${parsed.claimId.slice(0, 8)}…, age=${Math.round((Date.now() - parsed.createdAt) / 1000)}s)`
    );
  } catch {
    // Treat malformed /tmp as missing — caller falls through to KV.
  }
}

/** Clear all in-memory + on-disk bootstrap state. */
export function clearBootstrap(): void {
  activeBootstrap = null;
  bootstrapAuthTokenCache = null;
  claims.clear();
  // silent-swallow-ok: clearBootstrap is an idempotent teardown; missing /tmp is the success state
  try {
    if (existsSync(BOOTSTRAP_PATH)) unlinkSync(BOOTSTRAP_PATH);
  } catch {
    // Best-effort unlink.
  }
  // fire-and-forget OK: recovery cleanup path; caller does not wait on KV ack
  void deleteBootstrapFromKv();
}

// ── OBS-01 / OBS-02: rehydrate observability metadata ──────────────

/**
 * Bootstrap state as seen by observers (/api/health, /api/admin/status).
 * - `active` — process has a real or bootstrap-minted MCP_AUTH_TOKEN
 * - `pending` — first-run mode, no token yet
 * - `error`  — reserved for future use when rehydrate fails persistently
 */
export function getBootstrapState(): "pending" | "active" | "error" {
  if (isFirstRunMode()) return "pending";
  return "active";
}

async function recordRehydrateSuccess(): Promise<void> {
  if (!isExternalKvAvailable()) return;
  try {
    const kv = getKVStore();
    const now = new Date().toISOString();
    await kv.set(REHYDRATE_META_LAST_KEY, now);
    await incrementRehydrateCount();
  } catch (err) {
    firstRunLog.warn("rehydrate-meta write skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface RehydrateCountRecord {
  total: number;
  events: { at: string }[];
}

async function incrementRehydrateCount(): Promise<void> {
  try {
    const kv = getKVStore();
    const raw = await kv.get(REHYDRATE_COUNT_KV_KEY);
    const parsed: RehydrateCountRecord = raw
      ? (JSON.parse(raw) as RehydrateCountRecord)
      : { total: 0, events: [] };
    const nowMs = Date.now();
    const cutoff = nowMs - 24 * 60 * 60 * 1000;
    parsed.total += 1;
    parsed.events = parsed.events.filter((e) => new Date(e.at).getTime() > cutoff);
    parsed.events.push({ at: new Date(nowMs).toISOString() });
    // Defensive cap — long-lived deploys should never let this balloon.
    if (parsed.events.length > 10_000) parsed.events = parsed.events.slice(-1000);
    await kv.set(REHYDRATE_COUNT_KV_KEY, JSON.stringify(parsed));
  } catch (err) {
    firstRunLog.warn("rehydrate-count increment skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Most recent successful rehydrate timestamp, or null if no rehydrate
 * has ever landed on this KV backend (fresh deploy, KV not configured,
 * or never-initialized instance).
 */
export async function getLastRehydrateAt(): Promise<Date | null> {
  if (!isExternalKvAvailable()) return null;
  try {
    const kv = getKVStore();
    const iso = await kv.get(REHYDRATE_META_LAST_KEY);
    return iso ? new Date(iso) : null;
  } catch {
    return null;
  }
}

/**
 * Rehydrate count in aggregate (`total`) and in the last 24h rolling
 * window. Last24h is recomputed from the event log on every read so a
 * lambda that has been warm for >24h still returns the correct sliding
 * count.
 */
export async function getRehydrateCount(): Promise<{ total: number; last24h: number }> {
  if (!isExternalKvAvailable()) return { total: 0, last24h: 0 };
  try {
    const kv = getKVStore();
    const raw = await kv.get(REHYDRATE_COUNT_KV_KEY);
    if (!raw) return { total: 0, last24h: 0 };
    const parsed = JSON.parse(raw) as RehydrateCountRecord;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const last24h = parsed.events.filter((e) => new Date(e.at).getTime() > cutoff).length;
    return { total: parsed.total, last24h };
  } catch {
    return { total: 0, last24h: 0 };
  }
}

/**
 * Async re-hydration: first try /tmp (sync, fast path), then KV if /tmp
 * came up empty. If KV had a payload that /tmp didn't, mirror it back to
 * /tmp so the next cold start on this same instance hits the fast path.
 *
 * Handlers should call this at entry to pick up bootstrap state minted on
 * a different cold-start instance. Cheap when KV is unconfigured (no-op).
 *
 * v0.10 DUR-02 fold-in: the one-shot tenant-prefix migration trigger used
 * to live here as `void runV010TenantPrefixMigration().catch(() => {})`,
 * which fired on every rehydrate call and made test-order dependent on a
 * module-load disk-I/O side effect (ARCH-AUDIT §3). The trigger now lives
 * in `withBootstrapRehydrate` (src/core/with-bootstrap-rehydrate.ts) with
 * a one-shot module flag. Callers who rehydrate outside the HOC (tests,
 * internal helpers) must invoke the migration directly if needed.
 */
export async function rehydrateBootstrapAsync(): Promise<void> {
  // OBS-04: wrap in mymcp.bootstrap.rehydrate span when OTel is active.
  // When tracing is disabled, withSpan is a pass-through (no allocation).
  return withSpan("mymcp.bootstrap.rehydrate", () => _rehydrateBootstrapAsyncImpl(), {
    // Source attribute intentionally left `cold` — the trace is
    // emitted once per lambda process on first call. If a future
    // caller wants to distinguish cold/warm/forced, it can pass the
    // attribute through a richer API (out of scope for Phase 38).
    "mymcp.bootstrap.source": "cold",
  });
}

async function _rehydrateBootstrapAsyncImpl(): Promise<void> {
  rehydrateBootstrapFromTmp();
  // OBS-02 design note: we only record a rehydrate event when the KV
  // path actually did work (KV-hit below). The /tmp fast path runs on
  // every auth-gated request via withBootstrapRehydrate — counting it
  // would spam the counter with "hot lambda serving a normal request"
  // events and defeat the diagnostic purpose (distinguishing cold
  // starts that needed a KV roundtrip). Tests in src/core/first-run.test.ts
  // assert this: after a /tmp hit, `kv.get` is NOT called for
  // rehydrate-count bookkeeping.
  if (activeBootstrap) return;
  if (!isExternalKvAvailable()) return;
  const fromKv = await loadBootstrapFromKv();
  if (!fromKv) return;
  activeBootstrap = fromKv;
  claims.set(fromKv.claimId, { createdAt: fromKv.createdAt });
  if (!process.env.MCP_AUTH_TOKEN) {
    // SEC-02: populate the in-memory cache, NOT process.env.
    bootstrapAuthTokenCache = fromKv.token;
  }
  // Mirror back to /tmp for warm-instance fast path.
  // silent-swallow-ok: /tmp mirror is an optimization; KV is the source of truth
  try {
    writeFileSync(BOOTSTRAP_PATH, JSON.stringify(fromKv), { encoding: "utf-8" });
  } catch {
    // Read-only filesystem — KV remains authoritative.
  }
  console.info(
    `[Kebab MCP first-run] re-hydrated bootstrap from KV (claim=${fromKv.claimId.slice(0, 8)}…)`
  );
  // fire-and-forget OK: observability metadata write; losing a sample does not affect correctness of the rehydrate
  void recordRehydrateSuccess();
}

/** Test-only helper. Resets all module-level state. */
export function __resetFirstRunForTests(): void {
  claims.clear();
  activeBootstrap = null;
  bootstrapAuthTokenCache = null;
  // silent-swallow-ok: test-helper cleanup; missing /tmp is the success state
  try {
    if (existsSync(BOOTSTRAP_PATH)) unlinkSync(BOOTSTRAP_PATH);
  } catch {
    // Ignore absent /tmp file.
  }
  // fire-and-forget OK: test-helper cleanup; test runner awaits via __resetFirstRunForTestsAsync() when the KV ack actually matters
  void deleteBootstrapFromKv();
}

/** Test-only helper. Awaitable variant — guarantees KV is cleared too. */
export async function __resetFirstRunForTestsAsync(): Promise<void> {
  __resetFirstRunForTests();
  await deleteBootstrapFromKv();
}

// Test-only internals (not part of the public API).
export const __internals = {
  BOOTSTRAP_TTL_MS,
  BOOTSTRAP_PATH,
  encodeCookie,
};

// Re-export for tests that need to assert the 503 path.
export { SigningSecretUnavailableError };

// v0.11 Phase 41 T20 fold-in: the module-load `rehydrateBootstrapFromTmp();`
// side effect was removed. The composable request pipeline's
// `rehydrateStep` (src/core/pipeline/rehydrate-step.ts) is the single
// deterministic entry point. Tests that need rehydrate must call it
// explicitly (e.g., via `rehydrateBootstrapAsync()` in setup).
