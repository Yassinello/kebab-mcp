/**
 * First-run claim cookie HMAC signing secret.
 *
 * Pre-v0.10, the secret was derived from `VERCEL_GIT_COMMIT_SHA` — a
 * public value (Vercel preview URL footer, GitHub commit list). An
 * attacker who knew the SHA could forge a valid claim cookie and hijack
 * the welcome mint on any fresh public deploy. See:
 *   .planning/research/RISKS-AUDIT.md finding #2
 *   docs/SECURITY-ADVISORIES.md (GHSA-XXXX-XXXX-XXXX, SEC-04)
 *
 * Post-v0.10 the secret is 32 bytes of `randomBytes`, persisted in KV at
 * `mymcp:firstrun:signing-secret`, rotated on `MYMCP_RECOVERY_RESET=1`,
 * and refused outright (`SigningSecretUnavailableError`) on public deploys
 * that have no durable KV and no `MYMCP_ALLOW_EPHEMERAL_SECRET=1` opt-in.
 *
 * Module-scope cache:
 *   - First use: read KV → return or mint+persist.
 *   - Subsequent calls in the same lambda: return cached value.
 *   - `rotateSigningSecret()` or `resetSigningSecretCache()` invalidate.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKVStore } from "./kv-store";
import { hasUpstashCreds } from "./upstash-env";

export const SIGNING_SECRET_KV_KEY = "mymcp:firstrun:signing-secret";
const TMP_SEED_PATH = join(tmpdir(), "mymcp-signing-seed");

/**
 * Thrown when no durable secret can be minted on a production-like
 * deploy. Caller (welcome routes) surfaces this as a 503 with
 * operator-actionable remediation.
 */
export class SigningSecretUnavailableError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "Cannot mint welcome claims: no durable KV (Upstash) is configured " +
          "and no /tmp seed is permitted. Set UPSTASH_REDIS_REST_URL (and " +
          "UPSTASH_REDIS_REST_TOKEN) for production, or set " +
          "MYMCP_ALLOW_EPHEMERAL_SECRET=1 for local/dev. This refusal is by " +
          "design — without a persisted secret, anyone who can read the " +
          "public commit SHA can forge a claim cookie."
    );
    this.name = "SigningSecretUnavailableError";
  }
}

let cache: string | null = null;

/**
 * True when Upstash REST credentials (either naming variant) are set.
 * Thin delegate to the single-reader helper — see DUR-06.
 */
function isExternalKvAvailable(): boolean {
  return hasUpstashCreds();
}

async function readFromKv(): Promise<string | null> {
  if (!isExternalKvAvailable()) return null;
  try {
    const kv = getKVStore();
    const raw = await kv.get(SIGNING_SECRET_KV_KEY);
    if (raw && typeof raw === "string" && raw.length >= 16) return raw;
    return null;
  } catch {
    return null;
  }
}

async function writeToKvIfAbsent(value: string): Promise<void> {
  if (!isExternalKvAvailable()) return;
  try {
    const kv = getKVStore();
    // SETNX would be ideal for atomic first-writer-wins, but KVStore
    // doesn't expose SETNX today. Read-then-set is racy across lambdas;
    // mitigated by re-reading after write to pick the authoritative value.
    const existing = await kv.get(SIGNING_SECRET_KV_KEY);
    if (!existing) await kv.set(SIGNING_SECRET_KV_KEY, value);
  } catch {
    // Best-effort. The caller will re-read; if KV is unreachable, the
    // cold-start path may surface SigningSecretUnavailableError instead.
  }
}

async function writeToKvForce(value: string): Promise<void> {
  if (!isExternalKvAvailable()) return;
  const kv = getKVStore();
  await kv.set(SIGNING_SECRET_KV_KEY, value);
}

function readFromTmp(): string | null {
  try {
    if (!existsSync(TMP_SEED_PATH)) return null;
    const v = readFileSync(TMP_SEED_PATH, "utf8").trim();
    return v.length >= 16 ? v : null;
  } catch {
    return null;
  }
}

function writeToTmp(value: string): void {
  try {
    writeFileSync(TMP_SEED_PATH, value, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(TMP_SEED_PATH, 0o600);
    } catch {
      // Best-effort on Windows/CI.
    }
  } catch {
    // Best-effort; falls back to in-memory cache only.
  }
}

/**
 * Whether ephemeral (in-process / /tmp-only) secrets are allowed on this
 * deploy. Allowed when:
 *   - `MYMCP_ALLOW_EPHEMERAL_SECRET=1` (explicit opt-in), OR
 *   - `NODE_ENV !== "production"` (dev/test), OR
 *   - `VERCEL !== "1"` (non-Vercel hosts typically have a persistent FS).
 *
 * A production Vercel deploy without Upstash and without the opt-in flag
 * will refuse to mint welcome claims — that is the SEC-05 requirement.
 */
function allowEphemeral(): boolean {
  if (process.env.MYMCP_ALLOW_EPHEMERAL_SECRET === "1") return true;
  if (process.env.NODE_ENV !== "production") return true;
  if (process.env.VERCEL !== "1") return true;
  return false;
}

/**
 * Get the current signing secret, minting one on first use if needed.
 * Throws `SigningSecretUnavailableError` on production-like deploys that
 * have neither durable KV nor the ephemeral opt-in.
 */
export async function getSigningSecret(): Promise<string> {
  if (cache) return cache;

  const fromKv = await readFromKv();
  if (fromKv) {
    cache = fromKv;
    return fromKv;
  }

  if (!isExternalKvAvailable()) {
    const fromTmp = readFromTmp();
    if (fromTmp) {
      cache = fromTmp;
      return fromTmp;
    }
    if (!allowEphemeral()) {
      throw new SigningSecretUnavailableError();
    }
    const fresh = randomBytes(32).toString("hex");
    writeToTmp(fresh);
    cache = fresh;
    return fresh;
  }

  // Durable KV is configured but held no value — mint + persist.
  const fresh = randomBytes(32).toString("hex");
  await writeToKvIfAbsent(fresh);
  // Re-read to pick up the authoritative value if another lambda won the race.
  const authoritative = (await readFromKv()) || fresh;
  cache = authoritative;
  return authoritative;
}

/**
 * Rotate the signing secret. Used by `MYMCP_RECOVERY_RESET=1` to
 * invalidate any outstanding pre-reset claim cookies.
 */
export async function rotateSigningSecret(): Promise<string> {
  const fresh = randomBytes(32).toString("hex");
  if (isExternalKvAvailable()) {
    try {
      await writeToKvForce(fresh);
    } catch {
      // Fall through — we still clear the cache; next getSigningSecret()
      // will mint again against whatever backend is reachable.
    }
  } else {
    writeToTmp(fresh);
  }
  cache = fresh;
  return fresh;
}

/** Clear the module-scope cache. Test-only. */
export function resetSigningSecretCache(): void {
  cache = null;
}
