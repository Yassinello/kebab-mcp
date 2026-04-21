import { NextResponse } from "next/server";
import {
  bootstrapToken,
  flushBootstrapToKv,
  isClaimer,
  isFirstRunMode,
  isBootstrapActive,
} from "@/core/first-run";
import { SigningSecretUnavailableError } from "@/core/signing-secret";
import { getEnvStore, isVercelAutoMagicAvailable, triggerVercelRedeploy } from "@/core/env-store";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

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
 */
async function postHandler(request: Request) {
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

  // Block on the KV write before responding. Without this, Vercel
  // terminates the lambda when `return NextResponse.json(...)` resolves
  // — the in-flight Upstash SET is cancelled and the bootstrap key
  // stays empty, so every cold lambda after that sees first-run mode
  // and locks the user out of /config behind a /welcome redirect loop.
  // We surface flush failures (auth error, rate limit, network) as a
  // 500 so the UI shows a real error rather than a "success" that
  // leaves the user with a doomed token.
  try {
    await flushBootstrapToKv();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Kebab MCP first-run] flushBootstrapToKv failed: ${msg}`);
    return NextResponse.json(
      {
        error: "Token minted but persistence to KV failed — please retry. Details: " + msg,
      },
      { status: 500 }
    );
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

export const POST = withBootstrapRehydrate(postHandler);
