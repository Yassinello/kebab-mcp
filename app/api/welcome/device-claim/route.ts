/**
 * Phase 52 / DEV-04 — /api/welcome/device-claim.
 *
 * The second-device mini-welcome endpoint. A caller presents the
 * HMAC-signed invite token (minted via /api/admin/devices { action:
 * 'invite' }) and, on a valid + unexpired + unconsumed invite:
 *
 *   1. Consumes the nonce atomically via kv.setIfNotExists.
 *   2. Mints a fresh 64-hex device token via randomBytes(32).
 *   3. Appends the new token to MCP_AUTH_TOKEN's comma-list via the
 *      Phase 48 env-store facade.
 *   4. Persists a device-label KV entry so the operator sees the new
 *      device in /config → Devices immediately.
 *   5. Returns the minted token in the response body — once, never
 *      re-fetchable.
 *
 * No admin auth: the HMAC-signed URL IS the auth. Rate-limited per IP
 * so an attacker with a leaked signed URL cannot mint millions of
 * tokens against the comma-list. Opt-in via the rate-limit env flag.
 *
 * Error mapping:
 *   - 400: malformed body / missing token
 *   - 410: expired invite
 *   - 409: nonce already consumed (replay)
 *   - 401: signature mismatch / wrong intent
 *   - 503: getSigningSecret refusal (SEC-05)
 */

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import {
  composeRequestPipeline,
  rehydrateStep,
  rateLimitStep,
  type PipelineContext,
} from "@/core/pipeline";
import { verifyDeviceInvite, consumeDeviceInvite } from "@/core/device-invite";
import { getEnvStore } from "@/core/env-store";
import { SigningSecretUnavailableError } from "@/core/signing-secret";
import { getConfig } from "@/core/config-facade";
import { parseTokens, tokenId } from "@/core/auth";
import { getContextKVStore } from "@/core/request-context";
import { toMsg } from "@/core/error-utils";

interface ClaimBody {
  token?: string;
}

async function deviceClaimHandler(ctx: PipelineContext): Promise<Response> {
  let body: ClaimBody;
  try {
    body = (await ctx.request.json()) as ClaimBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const urlToken = typeof body.token === "string" ? body.token.trim() : "";
  if (!urlToken) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  // Verify HMAC + expiry + intent.
  let verifyResult;
  try {
    verifyResult = await verifyDeviceInvite(urlToken);
  } catch (err) {
    if (err instanceof SigningSecretUnavailableError) {
      return NextResponse.json(
        {
          error: "signing_secret_unavailable",
          message: err.message,
          hint: "Set UPSTASH_REDIS_REST_URL (Upstash). See docs/SECURITY-ADVISORIES.md#sec-05.",
        },
        { status: 503 }
      );
    }
    throw err;
  }

  if (!verifyResult.ok) {
    switch (verifyResult.reason) {
      case "expired":
        return NextResponse.json({ error: "expired" }, { status: 410 });
      case "bad_signature":
      case "wrong_intent":
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      case "malformed":
      default:
        return NextResponse.json({ error: "malformed_token" }, { status: 400 });
    }
  }

  const { payload } = verifyResult;

  // Atomic nonce consumption. Second caller with the same token → 409.
  const won = await consumeDeviceInvite(payload.nonce, payload.label, payload.expiresAt);
  if (!won) {
    return NextResponse.json({ error: "already_consumed" }, { status: 409 });
  }

  // Mint + splice. randomBytes(32).toString("hex") matches the welcome/init
  // mint primitive (Phase 45) bit-for-bit.
  const newToken = randomBytes(32).toString("hex");
  const newTokenId = tokenId(newToken);
  const currentList = parseTokens(getConfig("MCP_AUTH_TOKEN"));
  const updatedList = [...currentList, newToken].join(",");
  try {
    await getEnvStore().write({ MCP_AUTH_TOKEN: updatedList });
  } catch (err) {
    // Env-store writes are best-effort on Vercel (requires VERCEL_TOKEN);
    // surface the error so the operator can retry.
    return NextResponse.json({ error: "env_write_failed", message: toMsg(err) }, { status: 500 });
  }

  // Persist the device label so the new row appears in /config → Devices
  // immediately. No raw token stored — just tokenId + label + createdAt.
  try {
    const kv = getContextKVStore();
    await kv.set(
      `devices:${newTokenId}`,
      JSON.stringify({ label: payload.label, createdAt: new Date().toISOString() })
    );
  } catch {
    // silent-swallow-ok: label persistence is best-effort; the token is already
    // in MCP_AUTH_TOKEN so auth works. Operator can rename from Devices tab.
  }

  return NextResponse.json({ token: newToken, tokenId: newTokenId, label: payload.label });
}

export const POST = composeRequestPipeline(
  [rehydrateStep, rateLimitStep({ scope: "welcome-device-claim", keyFrom: "ip", limit: 5 })],
  deviceClaimHandler
);
