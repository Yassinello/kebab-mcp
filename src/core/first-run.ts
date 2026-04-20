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
 * This module is the single source of truth for first-run state. It is safe
 * to import from anywhere — it is side-effect free at module-load apart from
 * the rehydrate attempt, which silently swallows errors.
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
import { runV010TenantPrefixMigration } from "./migrations/v0.10-tenant-prefix";

const KV_BOOTSTRAP_KEY = "mymcp:firstrun:bootstrap";

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
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) return true;
  if (process.env.VERCEL !== "1") return true;
  return false;
}

async function persistBootstrapToKv(payload: BootstrapPayload): Promise<void> {
  if (!isExternalKvAvailable()) return;
  try {
    const kv = getKVStore();
    await kv.set(KV_BOOTSTRAP_KEY, JSON.stringify(payload));
  } catch (err) {
    console.info(
      `[Kebab MCP first-run] KV persist skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

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
  try {
    writeFileSync(BOOTSTRAP_PATH, JSON.stringify(activeBootstrap), { encoding: "utf-8" });
    persisted = true;
  } catch {
    // Best effort: /tmp may be read-only in some environments.
  }

  // Fire-and-forget cross-instance persistence. Production endpoints
  // SHOULD additionally call `flushBootstrapToKv()` to guarantee the
  // write lands before the response is sent — see fn comment above.
  void persistBootstrapToKv(activeBootstrap);

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
  try {
    if (existsSync(BOOTSTRAP_PATH)) unlinkSync(BOOTSTRAP_PATH);
  } catch {
    // Ignore.
  }
  void deleteBootstrapFromKv();
  console.info("[Kebab MCP first-run] forceReset() called — bootstrap state cleared");
}

/** Re-hydrate bootstrap state from /tmp on cold start. Called at module load. */
export function rehydrateBootstrapFromTmp(): void {
  if (process.env.MYMCP_RECOVERY_RESET === "1") {
    forceReset();
    // SEC-05: rotate the signing secret so pre-reset claim cookies no
    // longer verify. Fire-and-forget — rotation failure on KV outage
    // should not block cold-start.
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
    // Ignore malformed/missing bootstrap state.
  }
}

/** Clear all in-memory + on-disk bootstrap state. */
export function clearBootstrap(): void {
  activeBootstrap = null;
  bootstrapAuthTokenCache = null;
  claims.clear();
  try {
    if (existsSync(BOOTSTRAP_PATH)) unlinkSync(BOOTSTRAP_PATH);
  } catch {
    // Ignore.
  }
  void deleteBootstrapFromKv();
}

/**
 * Async re-hydration: first try /tmp (sync, fast path), then KV if /tmp
 * came up empty. If KV had a payload that /tmp didn't, mirror it back to
 * /tmp so the next cold start on this same instance hits the fast path.
 *
 * Handlers should call this at entry to pick up bootstrap state minted on
 * a different cold-start instance. Cheap when KV is unconfigured (no-op).
 *
 * SEC-01b side effect: also runs the v0.10 tenant-prefix migration
 * (idempotent, one-shot per process). Tracked via an in-process
 * `migrationStarted` flag + a KV-persisted `mymcp:migrations:*` marker.
 */
export async function rehydrateBootstrapAsync(): Promise<void> {
  // Run the migration in the background on first call; never block
  // boot on migration completion.
  void runV010TenantPrefixMigration().catch(() => {});

  rehydrateBootstrapFromTmp();
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
  try {
    writeFileSync(BOOTSTRAP_PATH, JSON.stringify(fromKv), { encoding: "utf-8" });
  } catch {
    // Ignore.
  }
  console.info(
    `[Kebab MCP first-run] re-hydrated bootstrap from KV (claim=${fromKv.claimId.slice(0, 8)}…)`
  );
}

/** Test-only helper. Resets all module-level state. */
export function __resetFirstRunForTests(): void {
  claims.clear();
  activeBootstrap = null;
  bootstrapAuthTokenCache = null;
  try {
    if (existsSync(BOOTSTRAP_PATH)) unlinkSync(BOOTSTRAP_PATH);
  } catch {
    // Ignore.
  }
  // Also clear KV (sync path with best-effort fire-and-forget).
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

// Side effect: try to hydrate on first import (cold-start safe).
rehydrateBootstrapFromTmp();
