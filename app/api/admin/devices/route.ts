/**
 * Phase 52 / DEV-03 — /api/admin/devices admin route.
 *
 * GET    → list devices (root-scope only); each device carries its
 *          optional connector allowlist (`connectors: string[] | null`).
 * POST   → { action: "rotate" | "rename" | "set-connectors" | "invite", ... }
 *          set-connectors: { tokenId, connectors: string[] | null } — pin or
 *          clear a token's per-connector scope (v0.20). null = full access.
 * DELETE → ?tokenId=XXXXXXXX revoke a device
 *
 * All three verbs compose the standard admin pipeline:
 *   composeRequestPipeline([rehydrateStep, authStep("admin"), rateLimitStep({...})])
 *
 * Root-scope gate: scoped admins (non-null tenantId) see 403 root_only
 * on every action — per-tenant device management is out of scope for
 * Phase 52 (multi-tenant admin granularity is a Phase 53+ topic).
 *
 * Rate-limit scope: "admin-devices", limit=10/min keyed by token.
 * Mutating admin actions are tighter than the default 60 rpm because a
 * compromised admin token should not be able to mass-rotate the whole
 * device list in a single burst.
 *
 * Invite semantics: POST { action: "invite" } delegates to
 * `src/core/device-invite.ts::mintDeviceInvite`. The nonce is
 * NOT marked consumed here — consumption happens on the claim side
 * (`/api/welcome/device-claim`) so an invite URL can expire unused
 * without polluting the consumed-nonce namespace.
 */

import { NextResponse } from "next/server";
import {
  composeRequestPipeline,
  rehydrateStep,
  authStep,
  rateLimitStep,
  type PipelineContext,
} from "@/core/pipeline";
import { getCurrentTenantId } from "@/core/request-context";
import {
  listDevices,
  setDeviceLabel,
  deleteDevice,
  rotateDeviceToken,
  setDeviceConnectors,
} from "@/core/devices";
import { mintDeviceInvite } from "@/core/device-invite";
import { SigningSecretUnavailableError } from "@/core/signing-secret";
import { parseTokens, tokenId } from "@/core/auth";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";

function rootOnlyGuard(): Response | null {
  if (getCurrentTenantId() !== null) {
    return NextResponse.json({ error: "root_only" }, { status: 403 });
  }
  return null;
}

// ── GET ────────────────────────────────────────────────────────────────

async function getHandler(_ctx: PipelineContext): Promise<Response> {
  const guard = rootOnlyGuard();
  if (guard) return guard;
  const devices = await listDevices();
  return NextResponse.json({ devices });
}

// ── POST (action dispatch) ────────────────────────────────────────────

interface PostBody {
  action?: string;
  tokenId?: string;
  label?: string;
  connectors?: string[] | null;
}

async function handleRotate(body: PostBody): Promise<Response> {
  const targetId = body.tokenId;
  if (!targetId || typeof targetId !== "string") {
    return NextResponse.json({ error: "missing_tokenId" }, { status: 400 });
  }
  // Pre-validate presence so we return a clean 404 rather than the
  // bubbled-up "not_found: tokenId …" from rotateDeviceToken.
  const tokens = parseTokens(getConfig("MCP_AUTH_TOKEN"));
  const present = tokens.some((t) => tokenId(t) === targetId);
  if (!present) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const { newToken, newTokenId } = await rotateDeviceToken(targetId);
    return NextResponse.json({ newToken, newTokenId });
  } catch (err) {
    const msg = toMsg(err);
    if (msg.toLowerCase().includes("not_found")) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "rotate_failed", message: msg }, { status: 500 });
  }
}

async function handleRename(body: PostBody): Promise<Response> {
  const targetId = body.tokenId;
  const label = body.label;
  if (!targetId || typeof targetId !== "string") {
    return NextResponse.json({ error: "missing_tokenId" }, { status: 400 });
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    return NextResponse.json({ error: "invalid_label" }, { status: 400 });
  }
  try {
    await setDeviceLabel(targetId, label);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = toMsg(err);
    if (msg.toLowerCase().includes("label")) {
      return NextResponse.json({ error: "invalid_label", message: msg }, { status: 400 });
    }
    return NextResponse.json({ error: "rename_failed", message: msg }, { status: 500 });
  }
}

async function handleSetConnectors(body: PostBody): Promise<Response> {
  const targetId = body.tokenId;
  if (!targetId || typeof targetId !== "string") {
    return NextResponse.json({ error: "missing_tokenId" }, { status: 400 });
  }
  // `connectors` must be an array of connector ids, or null to clear the
  // scope (full access). Anything else is a bad request.
  const connectors = body.connectors;
  if (connectors !== null && !Array.isArray(connectors)) {
    return NextResponse.json({ error: "invalid_connectors" }, { status: 400 });
  }
  // Pre-validate token presence so we return a clean 404 rather than
  // silently pinning a scope to a tokenId that isn't in MCP_AUTH_TOKEN.
  const tokens = parseTokens(getConfig("MCP_AUTH_TOKEN"));
  const present = tokens.some((t) => tokenId(t) === targetId);
  if (!present) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    await setDeviceConnectors(targetId, connectors);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = toMsg(err);
    if (msg.toLowerCase().includes("unknown connector")) {
      return NextResponse.json({ error: "unknown_connector", message: msg }, { status: 400 });
    }
    return NextResponse.json({ error: "set_connectors_failed", message: msg }, { status: 500 });
  }
}

async function handleInvite(body: PostBody): Promise<Response> {
  const label = body.label;
  if (typeof label !== "string" || label.trim().length === 0 || label.length > 40) {
    return NextResponse.json({ error: "invalid_label" }, { status: 400 });
  }
  try {
    const { url, nonce, expiresAt } = await mintDeviceInvite({
      tenantId: getCurrentTenantId(),
      label: label.trim(),
    });
    return NextResponse.json({ url, nonce, expiresAt });
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
    return NextResponse.json({ error: "invite_failed", message: toMsg(err) }, { status: 500 });
  }
}

async function postHandler(ctx: PipelineContext): Promise<Response> {
  const guard = rootOnlyGuard();
  if (guard) return guard;

  let body: PostBody;
  try {
    body = (await ctx.request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  switch (body.action) {
    case "rotate":
      return handleRotate(body);
    case "rename":
      return handleRename(body);
    case "set-connectors":
      return handleSetConnectors(body);
    case "invite":
      return handleInvite(body);
    default:
      return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  }
}

// ── DELETE ────────────────────────────────────────────────────────────

async function deleteHandler(ctx: PipelineContext): Promise<Response> {
  const guard = rootOnlyGuard();
  if (guard) return guard;

  const url = new URL(ctx.request.url);
  const targetId = url.searchParams.get("tokenId")?.trim();
  if (!targetId) {
    return NextResponse.json({ error: "missing_tokenId" }, { status: 400 });
  }
  const tokens = parseTokens(getConfig("MCP_AUTH_TOKEN"));
  const match = tokens.find((t) => tokenId(t) === targetId);
  if (!match) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const result = await deleteDevice(targetId, match);
  return NextResponse.json({ revoked: true, ...result });
}

// ── pipeline wiring ────────────────────────────────────────────────────

const pipelineSteps = [
  rehydrateStep,
  authStep("admin"),
  rateLimitStep({ scope: "admin-devices", keyFrom: "token", limit: 10 }),
];

export const GET = composeRequestPipeline(pipelineSteps, getHandler);
export const POST = composeRequestPipeline(pipelineSteps, postHandler);
export const DELETE = composeRequestPipeline(pipelineSteps, deleteHandler);
