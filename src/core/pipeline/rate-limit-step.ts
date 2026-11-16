/**
 * rateLimitStep — PIPE-03 + PIPE-04.
 *
 * Factory returning a Step that gates a request via `checkRateLimit(…)`.
 * Opt-in via `MYMCP_RATE_LIMIT_ENABLED=true` (defaults OFF so no existing
 * deployment is surprised), except for steps created with `alwaysOn`.
 *
 * Correctness precondition: this step MUST run after `authStep` on paths
 * that resolve a tenantId. `authStep` re-enters `requestContext.run`
 * with the tenantId so `checkRateLimit` (which reads
 * `getCurrentTenantId()`) keys buckets per-tenant. Pre-Phase-41 the
 * inline preamble in `[transport]/route.ts` ran `checkRateLimit`
 * BEFORE `requestContext.run`, which keyed every bucket under
 * `"global"` (POST-V0.10-AUDIT §B.2).
 *
 * Key derivation conventions (documented for Phase 42 authors):
 *   - `keyFrom: 'token'`    → `ctx.tokenId ?? extractToken(request) ?? 'unknown'`
 *                             Used by: MCP transport (per-token-per-tenant)
 *   - `keyFrom: 'ip'`       → left-most `x-forwarded-for` value → `x-real-ip` → 'unknown'
 *                             Used by: webhook/[name], welcome/claim (anonymous)
 *   - `keyFrom: 'cronSecretTokenId'` → sha256-first-8 of `process.env.CRON_SECRET`
 *                             Used by: cron/health (per-deployment rate)
 *
 * Response on deny: 429 with `Retry-After: <seconds>` + `X-RateLimit-Remaining: 0`,
 * body `{ error: "Rate limit exceeded" }` — matches the existing
 * transport preamble bit-for-bit.
 */

import type { Step } from "./types";
import { checkRateLimit } from "../rate-limit";
import { extractToken } from "../auth";
import { getClientIP } from "../request-utils";
import { createHash } from "node:crypto";
import { getConfig } from "../config-facade";

export type RateLimitKeyFrom = "token" | "ip" | "cronSecretTokenId";

export interface RateLimitStepOptions {
  scope: string;
  keyFrom: RateLimitKeyFrom;
  limit?: number;
  /** Window length in seconds (default 60). */
  windowSeconds?: number;
  /** Override the env var that controls opt-in. Defaults to `MYMCP_RATE_LIMIT_ENABLED`. */
  enabledEnv?: string;
  /**
   * Audit 2026-11: enforce the limit even when the opt-in flag is off — for
   * anonymous endpoints that write to storage (OAuth registration, token,
   * revocation).
   */
  alwaysOn?: boolean;
}

function deriveKey(keyFrom: RateLimitKeyFrom, request: Request, tokenId: string | null): string {
  switch (keyFrom) {
    case "token": {
      if (tokenId) return tokenId;
      return extractToken(request) ?? "unknown";
    }
    case "ip": {
      return getClientIP(request);
    }
    case "cronSecretTokenId": {
      const secret = getConfig("CRON_SECRET") ?? "";
      return createHash("sha256").update(secret).digest("hex").slice(0, 8);
    }
  }
}

export function rateLimitStep(options: RateLimitStepOptions): Step {
  const envKey = options.enabledEnv ?? "MYMCP_RATE_LIMIT_ENABLED";
  return async (ctx, next) => {
    if (!options.alwaysOn && getConfig(envKey) !== "true") return next();

    const identifier = deriveKey(options.keyFrom, ctx.request, ctx.tokenId);
    const result = await checkRateLimit(identifier, {
      scope: options.scope,
      limit: options.limit,
      windowSeconds: options.windowSeconds,
    });
    if (!result.allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil((result.resetAt - Date.now()) / 1000)),
          "X-RateLimit-Remaining": "0",
        },
      });
    }
    return next();
  };
}
