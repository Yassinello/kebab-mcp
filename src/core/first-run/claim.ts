/**
 * Claim primitives: signed cookie helpers and the claim Map.
 *
 * "Claims" are browser-side signed cookies issued by /api/welcome/claim.
 * Only ONE active claim is allowed at a time — first writer wins.
 * The higher-level `getOrCreateClaim` and `isClaimer` live in bootstrap.ts
 * because they need access to `activeBootstrap` (avoids circular imports).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getSigningSecret } from "../signing-secret";

export const FIRST_RUN_COOKIE_NAME = "mymcp_firstrun_claim";
export const CLAIM_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ClaimResult {
  claimId: string;
  isNewClaim: boolean;
  isClaimer: boolean;
  cookieToSet?: string;
}

interface ClaimRecord {
  createdAt: number;
}

// Module-level claim store shared with bootstrap.ts via this export.
export const claims = new Map<string, ClaimRecord>();

// ── Internal crypto helpers ──────────────────────────────────────────────────

/**
 * SEC-07 (2026-11 audit): claim cookies are `claimId.issuedAtMs.sig` where
 * `sig = HMAC(secret, "kebab:claim:v2:" + claimId + "." + issuedAtMs)`.
 *  - The domain prefix separates claim signatures from device-invite
 *    signatures made with the same secret (an invite can no longer be
 *    replayed as a claim cookie).
 *  - `issuedAtMs` is covered by the signature and checked server-side, so a
 *    captured cookie stops working after CLAIM_TTL_MS regardless of the
 *    browser's Max-Age.
 * Legacy `claimId.sig` cookies are rejected (only affects a welcome flow in
 * progress during the upgrade — the user simply re-claims).
 */
const CLAIM_SIG_DOMAIN = "kebab:claim:v2:";

async function sign(value: string): Promise<string> {
  const secret = await getSigningSecret();
  return createHmac("sha256", secret)
    .update(CLAIM_SIG_DOMAIN + value)
    .digest("hex");
}

function safeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export async function encodeCookie(
  claimId: string,
  issuedAtMs: number = Date.now()
): Promise<string> {
  const body = `${claimId}.${issuedAtMs}`;
  return `${body}.${await sign(body)}`;
}

async function decodeCookie(raw: string, now: number = Date.now()): Promise<string | null> {
  // Resolve the secret first so an insecure deploy (no durable secret)
  // surfaces SigningSecretUnavailableError → 503 even for malformed cookies.
  await getSigningSecret();
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [claimId, issuedAtRaw, sig] = parts as [string, string, string];
  if (!claimId || !issuedAtRaw || !sig) return null;
  if (!/^\d{1,16}$/.test(issuedAtRaw)) return null;
  if (!safeEqHex(sig, await sign(`${claimId}.${issuedAtRaw}`))) return null;
  const issuedAt = Number(issuedAtRaw);
  // Small clock-skew allowance into the future; hard expiry in the past.
  if (issuedAt > now + 60_000) return null;
  if (now - issuedAt > CLAIM_TTL_MS) return null;
  return claimId;
}

export async function readClaimCookie(request: Request): Promise<string | null> {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  const re = new RegExp(`(?:^|;\\s*)${FIRST_RUN_COOKIE_NAME}=([^;]+)`);
  const m = cookieHeader.match(re);
  const raw = m?.[1];
  if (!raw) return null;
  return decodeCookie(decodeURIComponent(raw));
}
