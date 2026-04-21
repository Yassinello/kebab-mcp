import { NextResponse } from "next/server";
import {
  getOrCreateClaim,
  isFirstRunMode,
  isBootstrapActive,
  FIRST_RUN_COOKIE_NAME,
  CLAIM_TTL_MS,
} from "@/core/first-run";
import { SigningSecretUnavailableError } from "@/core/signing-secret";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * POST /api/welcome/claim
 *
 * Returns one of:
 *   { status: "already-initialized" } — instance has a permanent token
 *   { status: "claimer", isNew: false }
 *   { status: "new", isNew: true } (sets cookie)
 *   { status: "claimed-by-other" }
 */
async function postHandler(request: Request) {
  if (!isFirstRunMode() && !isBootstrapActive()) {
    return NextResponse.json({ status: "already-initialized" });
  }

  let result;
  try {
    result = await getOrCreateClaim(request);
  } catch (err) {
    // SEC-05: refuse to mint claims on deploys without a durable secret.
    if (err instanceof SigningSecretUnavailableError) {
      return NextResponse.json(
        {
          status: "signing_secret_unavailable",
          error: "signing_secret_unavailable",
          message: err.message,
          hint: "Set UPSTASH_REDIS_REST_URL (Upstash) or, for local dev, MYMCP_ALLOW_EPHEMERAL_SECRET=1. See docs/SECURITY-ADVISORIES.md#sec-05.",
        },
        { status: 503 }
      );
    }
    throw err;
  }

  if (!result.isClaimer) {
    return NextResponse.json({ status: "claimed-by-other" }, { status: 423 });
  }

  const status = result.isNewClaim ? "new" : "claimer";
  const res = NextResponse.json({ status, isNew: result.isNewClaim });

  if (result.cookieToSet) {
    // Secure cookie. Marked HttpOnly so the token claim can't be read from JS.
    const secureFlag = process.env.VERCEL === "1" ? "; Secure" : "";
    res.headers.set(
      "set-cookie",
      `${FIRST_RUN_COOKIE_NAME}=${encodeURIComponent(result.cookieToSet)}; Path=/; HttpOnly; SameSite=Strict${secureFlag}; Max-Age=${Math.floor(CLAIM_TTL_MS / 1000)}`
    );
  }

  return res;
}

export const POST = withBootstrapRehydrate(postHandler);
