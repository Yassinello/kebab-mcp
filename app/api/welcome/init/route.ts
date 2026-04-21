import { NextResponse } from "next/server";
import {
  bootstrapToken,
  flushBootstrapToKvIfAbsent,
  isClaimer,
  isFirstRunMode,
  isBootstrapActive,
} from "@/core/first-run";
import { SigningSecretUnavailableError } from "@/core/signing-secret";
import { getEnvStore, isVercelAutoMagicAvailable, triggerVercelRedeploy } from "@/core/env-store";
import {
  composeRequestPipeline,
  rehydrateStep,
  csrfStep,
  type PipelineContext,
} from "@/core/pipeline";

/**
 * POST /api/welcome/init
 *
 * Verifies the caller holds the active first-run claim cookie, then mints
 * the permanent MCP_AUTH_TOKEN and writes it into process.env via the
 * in-memory bridge. Returns the token to display once.
 *
 * Auto-magic mode: if VERCEL_TOKEN + VERCEL_PROJECT_ID are present, after
 * minting the token we ALSO write it to Vercel env vars and trigger a
 * production redeploy. Both steps are best-effort — failures are logged
 * but never bubble up: the user always has a working in-memory token they
 * can fall back to copy/paste.
 *
 * v0.11 Phase 41: pipeline provides rehydrate + CSRF. The route-specific
 * gates (MYMCP_RECOVERY_RESET, !isFirstRunMode && !isBootstrapActive,
 * isClaimer) stay in the handler body because they're too bespoke to
 * fold into a generic `authStep` variant.
 */
async function welcomeInitHandler(ctx: PipelineContext): Promise<Response> {
  const request = ctx.request;

  // Foot-shoot guard: MYMCP_RECOVERY_RESET=1 wipes the bootstrap on every
  // cold lambda startup (forceReset deletes /tmp + KV). Letting init mint
  // a token in this state hands the user a doomed credential — the very
  // next cold lambda erases it. Refuse outright until the operator
  // removes the env var.
  if (process.env.MYMCP_RECOVERY_RESET === "1") {
    return NextResponse.json(
      {
        error:
          "MYMCP_RECOVERY_RESET=1 is set on this deployment — every cold lambda wipes the bootstrap, so any token minted right now would vanish within minutes. Remove the env var from Vercel Settings → Environment Variables, redeploy, and run /welcome again.",
      },
      { status: 409 }
    );
  }

  if (!isFirstRunMode() && !isBootstrapActive()) {
    return NextResponse.json({ error: "Already initialized" }, { status: 409 });
  }

  try {
    if (!(await isClaimer(request))) {
      return NextResponse.json({ error: "Forbidden — not the claimer" }, { status: 403 });
    }
  } catch (err) {
    // SEC-05: refuse to mint on insecure deploys (no durable secret).
    if (err instanceof SigningSecretUnavailableError) {
      return NextResponse.json(
        {
          error: "signing_secret_unavailable",
          message: err.message,
          hint: "Set UPSTASH_REDIS_REST_URL (Upstash) or, for local dev, MYMCP_ALLOW_EPHEMERAL_SECRET=1. See docs/SECURITY-ADVISORIES.md#sec-05.",
        },
        { status: 503 }
      );
    }
    throw err;
  }

  // Read the claim id back from the cookie to pass to bootstrapToken.
  const cookieHeader = request.headers.get("cookie") || "";
  const m = cookieHeader.match(/(?:^|;\s*)mymcp_firstrun_claim=([^;]+)/);
  if (!m) {
    return NextResponse.json({ error: "Missing claim cookie" }, { status: 403 });
  }
  const decoded = decodeURIComponent(m[1]);
  const claimId = decoded.split(".")[0];

  const { token } = bootstrapToken(claimId);

  // Phase 45 UX-04: SETNX-gated flush. If two browsers share a claim
  // cookie and both issued POST /api/welcome/init concurrently, exactly
  // one wins the atomic Upstash SET NX and persists. The loser gets a
  // 409 — we DO NOT leak the winner's token in the body, only signal
  // that minting already happened so the loser can re-enter via the
  // already-initialized paste-token flow.
  //
  // On backends without setIfNotExists support (unexpected; all three
  // built-in backends implement it post-UX-04), the helper falls back
  // to the non-atomic set() — matches the pre-UX-04 contract so exotic
  // deployments don't hard-fail.
  //
  // Flush errors (auth / rate limit / network) still surface as a 500
  // via the existing contract: the caller retries rather than ships
  // a doomed token.
  let flushResult: Awaited<ReturnType<typeof flushBootstrapToKvIfAbsent>>;
  try {
    flushResult = await flushBootstrapToKvIfAbsent();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Kebab MCP first-run] flushBootstrapToKvIfAbsent failed: ${msg}`);
    return NextResponse.json(
      {
        error: "Token minted but persistence to KV failed — please retry. Details: " + msg,
      },
      { status: 500 }
    );
  }
  if (!flushResult.ok) {
    // Loser branch — another browser already minted. Do NOT echo the
    // winner's token in the response body.
    return NextResponse.json({ error: "already_minted" }, { status: 409 });
  }

  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("host") || "your-instance.vercel.app";
  const instanceUrl = `${proto}://${host}`;

  if (!isVercelAutoMagicAvailable()) {
    return NextResponse.json({ ok: true, token, instanceUrl, autoMagic: false });
  }

  // ── Auto-magic path ───────────────────────────────────────────────
  let envWritten = false;
  let redeployTriggered = false;
  let redeployError: string | undefined;

  console.info("[Kebab MCP first-run] auto-magic mode: writing MCP_AUTH_TOKEN to Vercel...");
  try {
    await getEnvStore().write({ MCP_AUTH_TOKEN: token });
    envWritten = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[Kebab MCP first-run] auto-magic env write failed: ${msg}`);
  }

  console.info("[Kebab MCP first-run] auto-magic mode: triggering redeploy...");
  try {
    const result = await triggerVercelRedeploy();
    if (result.ok) {
      redeployTriggered = true;
      console.info(
        `[Kebab MCP first-run] auto-magic mode: redeploy triggered (deployment=${result.deploymentId ?? "?"})`
      );
    } else {
      redeployError = result.error;
      console.warn(`[Kebab MCP first-run] auto-magic redeploy failed: ${result.error}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redeployError = msg;
    console.warn(`[Kebab MCP first-run] auto-magic redeploy threw: ${msg}`);
  }

  return NextResponse.json({
    ok: true,
    token,
    instanceUrl,
    autoMagic: true,
    envWritten,
    redeployTriggered,
    redeployError,
  });
}

export const POST = composeRequestPipeline([rehydrateStep, csrfStep], welcomeInitHandler);
