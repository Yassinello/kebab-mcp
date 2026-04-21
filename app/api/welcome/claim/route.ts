import { NextResponse } from "next/server";
import {
  getOrCreateClaim,
  isFirstRunMode,
  isBootstrapActive,
  FIRST_RUN_COOKIE_NAME,
  CLAIM_TTL_MS,
} from "@/core/first-run";
import { SigningSecretUnavailableError } from "@/core/signing-secret";
import {
  composeRequestPipeline,
  rehydrateStep,
  rateLimitStep,
  type PipelineContext,
} from "@/core/pipeline";

/**
 * POST /api/welcome/claim
 *
 * Returns one of:
 *   { status: "already-initialized" } — instance has a permanent token
 *   { status: "claimer", isNew: false }
 *   { status: "new", isNew: true } (sets cookie)
 *   { status: "claimed-by-other" }
 *
 * v0.11 Phase 41: pipeline provides rehydrate + IP-keyed rate-limit.
 * PIPE-04 rate-limit scope: 10/min/IP (opt-in via MYMCP_RATE_LIMIT_ENABLED).
 * Anonymous caller surface — IP is the right key. Closes the claim-spam
 * surface explicitly called out in POST-V0.10-AUDIT §B.2.
 */
async function welcomeClaimHandler(ctx: PipelineContext): Promise<Response> {
  const request = ctx.request;

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

export const POST = composeRequestPipeline(
  [rehydrateStep, rateLimitStep({ scope: "claim", keyFrom: "ip", limit: 10 })],
  welcomeClaimHandler
);
