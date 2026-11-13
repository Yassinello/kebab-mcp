/**
 * authStep — PIPE-02 + PIPE-03.
 *
 * Factory returning a step that runs one of three auth strategies:
 *   - 'mcp'    — `checkMcpAuth(request)` (token + `x-mymcp-tenant` header)
 *   - 'admin'  — `checkAdminAuth(request)` (ADMIN_AUTH_TOKEN + CSRF)
 *   - 'cron'   — CRON_SECRET Bearer match with loopback fallback
 *
 * On success:
 *   - writes `ctx.tokenId` (sha256 first-8 of the matched token)
 *   - writes `ctx.tenantId` from `checkMcpAuth` (MCP path) — admin/cron
 *     leave tenantId untouched (null = default tenant)
 *   - sets `ctx.authKind`
 *   - **RE-ENTERS `requestContext.run({ tenantId, credentials })` for
 *     its own `next()` call** so every downstream step + the terminal
 *     handler observes the resolved tenantId via `getCurrentTenantId()`.
 *     This is the central fix for POST-V0.10-AUDIT §B.2: pre-Phase-41,
 *     `checkRateLimit` ran outside requestContext.run and always keyed
 *     rate-limit buckets under `"global"` regardless of the real tenant.
 *
 * On failure: returns the 401/403/503 Response directly (no `next()`).
 */

import { createHash } from "node:crypto";
import type { Step, PipelineContext } from "./types";
import { checkMcpAuth, checkAdminAuth, safeCompare } from "../auth";
import { publicOrigin, resolveAccessToken, wwwAuthenticate } from "../oauth";
import { isLoopbackRequest } from "../request-utils";
import { requestContext } from "../request-context";
import { getConfig } from "../config-facade";

export type AuthKind = "mcp" | "admin" | "cron";

function cronTokenIdFromSecret(): string {
  const secret = getConfig("CRON_SECRET") ?? "";
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

/**
 * Re-enter requestContext.run with the resolved tenantId + credentials so
 * downstream steps and the handler see the correct ambient state via
 * `getCurrentTenantId()` / `getCredential()`. Called from every success
 * branch of authStep.
 */
function runWithResolvedContext(
  ctx: PipelineContext,
  next: () => Promise<Response>
): Promise<Response> {
  return requestContext.run(
    {
      tenantId: ctx.tenantId,
      credentials: ctx.credentials,
    },
    next
  );
}

export function authStep(kind: AuthKind): Step {
  if (kind === "mcp") {
    return async (ctx, next) => {
      const { error, tokenId, tenantId } = checkMcpAuth(ctx.request);
      if (error) {
        // Kebab House phase 1 (OAU-08): an OAuth access token resolves to
        // its device id; every per-token feature then applies unchanged.
        const bearer = ctx.request.headers
          .get("authorization")
          ?.replace(/^Bearer\s+/i, "")
          .trim();
        const deviceId = bearer ? await resolveAccessToken(bearer).catch(() => null) : null;
        if (deviceId) {
          ctx.tokenId = deviceId;
          ctx.tenantId = null;
          ctx.authKind = "mcp";
          return runWithResolvedContext(ctx, next);
        }
        // OAU-03: point MCP clients at the protected resource metadata.
        if (error.status === 401) {
          const headers = new Headers(error.headers);
          headers.set("WWW-Authenticate", wwwAuthenticate(publicOrigin(ctx.request)));
          return new Response(await error.text(), { status: 401, headers });
        }
        return error;
      }
      ctx.tokenId = tokenId;
      ctx.tenantId = tenantId;
      ctx.authKind = "mcp";
      return runWithResolvedContext(ctx, next);
    };
  }

  if (kind === "admin") {
    return async (ctx, next) => {
      const err = await checkAdminAuth(ctx.request);
      if (err) return err;
      // checkAdminAuth doesn't surface a tokenId. Derive one from the
      // bearer / cookie / query token so logging + request-scoped ids stay
      // consistent. Doesn't affect auth decisions (those already happened).
      // We avoid duplicating `extractToken` in this import graph; admin
      // routes rarely need tokenId, and when they do they read it from
      // the request directly.
      ctx.authKind = "admin";
      return runWithResolvedContext(ctx, next);
    };
  }

  // kind === 'cron'
  return async (ctx, next) => {
    const authHeader = ctx.request.headers.get("authorization");
    const cronSecret = getConfig("CRON_SECRET");

    if (cronSecret) {
      // SEC-15: constant-time comparison (was `!==`).
      if (!authHeader || !safeCompare(authHeader, `Bearer ${cronSecret}`)) {
        return new Response("Unauthorized", { status: 401 });
      }
    } else {
      if (!isLoopbackRequest(ctx.request)) {
        return new Response("CRON_SECRET not configured — cron endpoint is locked to loopback", {
          status: 503,
        });
      }
    }
    ctx.tokenId = cronSecret ? cronTokenIdFromSecret() : null;
    ctx.authKind = "cron";
    return runWithResolvedContext(ctx, next);
  };
}
