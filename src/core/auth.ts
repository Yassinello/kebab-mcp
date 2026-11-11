import { timingSafeEqual, createHash } from "crypto";
import { isLoopbackRequest } from "./request-utils";
import { isClaimer, getBootstrapAuthToken } from "./first-run";
import { getTenantId } from "./tenant";
import { withSpan, withSpanSync } from "./tracing";
import { getConfig } from "./config-facade";
import { BRAND, LEGACY_BRAND } from "./constants/brand";

/**
 * Auth utilities for Kebab MCP.
 *
 * Two auth scopes:
 * - MCP auth: protects the /api/mcp endpoint (MCP_AUTH_TOKEN)
 *   Supports comma-separated list of tokens for multi-client deployments.
 * - Admin auth: protects the dashboard/welcome UI (ADMIN_AUTH_TOKEN, falls back to MCP_AUTH_TOKEN)
 *   Always single-token.
 */

let adminTokenWarned = false;

function warnAdminTokenFallback() {
  if (adminTokenWarned) return;
  const hasMcp = Boolean(getConfig("MCP_AUTH_TOKEN") || getBootstrapAuthToken());
  if (!getConfig("ADMIN_AUTH_TOKEN") && !hasMcp) {
    console.warn(
      "[Kebab MCP Security] No auth tokens configured. Admin dashboard is publicly accessible."
    );
    adminTokenWarned = true;
  } else if (!getConfig("ADMIN_AUTH_TOKEN") && hasMcp) {
    console.warn(
      "[Kebab MCP Security] ADMIN_AUTH_TOKEN is not set. Falling back to MCP_AUTH_TOKEN for admin access. " +
        "Set a separate ADMIN_AUTH_TOKEN for better security isolation."
    );
    adminTokenWarned = true;
  }
}

export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Split a comma-separated token env value into individual tokens.
 * Trims whitespace and drops empty segments — safe to call with undefined.
 */
export function parseTokens(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Returns the first 8 hex chars of a token's SHA-256 hash.
 * Used for safe, non-reversible token identification in logs.
 */
export function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/**
 * Phase 50 / BRAND-02 — once-per-process dedupe for legacy-cookie reads.
 *
 * Separate from the brand-env-var dedupe set in config-facade.ts
 * (different concerns: env vs cookie, different keys). Reset via
 * `__resetAuthCookieWarnings()` in tests.
 */
const authCookieWarned = new Set<string>();

function warnLegacyCookieReadOnce(): void {
  if (authCookieWarned.has(LEGACY_BRAND.cookieName)) return;
  authCookieWarned.add(LEGACY_BRAND.cookieName);
  console.warn(
    `[deprecated] ${LEGACY_BRAND.cookieName} cookie is deprecated; new Set-Cookie writes use ${BRAND.cookieName}. Support removed in 2 releases.`
  );
}

/** Test-only: reset the legacy-cookie warning dedupe set. */
export function __resetAuthCookieWarnings(): void {
  authCookieWarned.clear();
}

/**
 * Read the admin cookie from a Cookie header, preferring the modern
 * `kebab_admin_token` name over the legacy `mymcp_admin_token`. When the
 * caller hits the legacy fallback, a single once-per-process deprecation
 * warning is emitted.
 *
 * Returns the URI-decoded, trimmed raw value, or null when neither cookie
 * is present / parseable.
 */
export function readAdminCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;

  const kebabRe = new RegExp(`(?:^|;\\s*)${BRAND.cookieName.replace(/[-_]/g, "[-_]")}=([^;]+)`);
  const legacyRe = new RegExp(
    `(?:^|;\\s*)${LEGACY_BRAND.cookieName.replace(/[-_]/g, "[-_]")}=([^;]+)`
  );

  const kebabMatch = cookieHeader.match(kebabRe);
  if (kebabMatch?.[1]) return decodeURIComponent(kebabMatch[1]).trim();

  const legacyMatch = cookieHeader.match(legacyRe);
  if (legacyMatch?.[1]) {
    warnLegacyCookieReadOnce();
    return decodeURIComponent(legacyMatch[1]).trim();
  }
  return null;
}

/**
 * Emit Set-Cookie headers for BOTH `kebab_admin_token` and
 * `mymcp_admin_token` with identical security attributes. Append via
 * `Headers.append` so the caller doesn't clobber any other pre-existing
 * Set-Cookie entries (e.g. session cookies set upstream).
 *
 * Default maxAge: 7 days. Caller may override.
 */
export function setAdminCookies(
  headers: Headers,
  token: string,
  opts?: { maxAge?: number; secure?: boolean; sameSite?: "Strict" | "Lax" | "None" }
): void {
  const maxAge = opts?.maxAge ?? 60 * 60 * 24 * 7;
  const secure = opts?.secure ?? true;
  const sameSite = opts?.sameSite ?? "Strict";
  const attrs = [
    "HttpOnly",
    `SameSite=${sameSite}`,
    ...(secure ? ["Secure"] : []),
    "Path=/",
    `Max-Age=${maxAge}`,
  ].join("; ");

  headers.append("Set-Cookie", `${BRAND.cookieName}=${token}; ${attrs}`);
  headers.append("Set-Cookie", `${LEGACY_BRAND.cookieName}=${token}; ${attrs}`);
}

/**
 * Emit Set-Cookie headers with `Max-Age=0` for BOTH cookie names, so a
 * logout / admin-rotation invalidates both the modern and the legacy
 * cookie in one write.
 */
export function clearAdminCookies(headers: Headers): void {
  const attrs = "HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0";
  headers.append("Set-Cookie", `${BRAND.cookieName}=; ${attrs}`);
  headers.append("Set-Cookie", `${LEGACY_BRAND.cookieName}=; ${attrs}`);
}

export function extractToken(request: Request): string | null {
  // Check Authorization header
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    return authHeader.replace(/^Bearer\s+/i, "").trim();
  }

  // Fallback: query string token (needed for Claude Desktop)
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token")?.trim();
  if (queryToken) return queryToken;

  // Fallback: admin cookie (set by middleware after ?token= auth).
  // Dashboard fetches from the browser rely on this. Phase 50 / BRAND-02:
  // prefer kebab_admin_token, fall back to mymcp_admin_token with one
  // deprecation warning per process.
  return readAdminCookie(request.headers.get("cookie"));
}

/**
 * Check MCP endpoint auth. Returns error Response or null if OK, plus the
 * matched tokenId.
 *
 * Fail-closed semantics:
 * - If MCP_AUTH_TOKEN is set → one of the tokens must match
 * - If MCP_AUTH_TOKEN is unset → only loopback requests are allowed
 *   (local dev convenience). Public deploys that forget to set the env
 *   var MUST NOT expose the tools endpoint — that would let the internet
 *   drive the operator's Gmail, GitHub, Calendar, Slack, etc. using the
 *   connector credentials the server already has.
 */
export function checkMcpAuth(request: Request): {
  error: Response | null;
  tokenId: string | null;
  tenantId: string | null;
} {
  // Phase 50 / BRAND-03: withSpan/withSpanSync normalize names via
  // brandSpanName() and brand-namespace attrs via brandSpanAttrs().
  // Callers pass unprefixed logical names and attribute keys.
  return withSpanSync("auth.check", () => _checkMcpAuthImpl(request), {
    "auth.kind": "mcp",
  });
}

function _checkMcpAuthImpl(request: Request): {
  error: Response | null;
  tokenId: string | null;
  tenantId: string | null;
} {
  // Extract tenant from header (null = default tenant, same as before).
  let tenantIdValue: string | null;
  try {
    tenantIdValue = getTenantId(request);
  } catch (err) {
    return {
      error: new Response(err instanceof Error ? err.message : "Bad tenant header", {
        status: 400,
      }),
      tokenId: null,
      tenantId: null,
    };
  }

  // Resolve token list: tenant-specific env var first, then global fallback.
  // SEC-02: default-tenant path also consults the in-memory bootstrap cache
  // so a welcome-minted token is recognized without mutating process.env.
  const tenantTokenEnv = tenantIdValue
    ? getConfig(`MCP_AUTH_TOKEN_${tenantIdValue.toUpperCase().replace(/-/g, "_")}`)
    : undefined;
  const bootstrapToken = tenantIdValue ? undefined : getBootstrapAuthToken();
  const tokens = parseTokens(
    tenantTokenEnv || getConfig("MCP_AUTH_TOKEN") || bootstrapToken || undefined
  );

  if (tokens.length === 0) {
    // First-run / dev: only loopback may skip auth.
    if (isLoopbackRequest(request)) return { error: null, tokenId: null, tenantId: tenantIdValue };
    return {
      error: new Response(
        "MCP_AUTH_TOKEN not configured on this server. Set it to enable the MCP endpoint.",
        { status: 503 }
      ),
      tokenId: null,
      tenantId: tenantIdValue,
    };
  }

  const provided = extractToken(request);
  if (provided) {
    for (const t of tokens) {
      if (safeCompare(provided, t)) {
        return { error: null, tokenId: tokenId(t), tenantId: tenantIdValue };
      }
    }
  }

  return { error: new Response("Unauthorized", { status: 401 }), tokenId: null, tenantId: null };
}

/**
 * Origin-header CSRF check for state-mutating admin routes.
 *
 * Defense-in-depth on top of SameSite=Strict — ensures that even if the
 * browser leaks the admin cookie cross-site (misconfigured proxy, buggy
 * future browser, etc.), the request's Origin header must still match
 * the server's host.
 *
 * Rules:
 * - GET/HEAD/OPTIONS are exempt (CSRF only matters for mutations)
 * - Missing Origin → allow (older clients, curl, server-to-server)
 * - Origin host must equal request host
 * - Returns null on success, 403 Response on mismatch.
 *
 * The Origin header is set by every browser on cross-site requests and
 * cannot be spoofed by JavaScript. curl/server-side requests don't set
 * it, which is why we allow the "missing" case.
 */
export function checkCsrf(request: Request): Response | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const origin = request.headers.get("origin");
  if (!origin) return null; // non-browser caller

  const host = request.headers.get("host");
  if (!host) return null; // should not happen in practice

  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      return new Response(`CSRF check failed — Origin ${originHost} does not match host ${host}`, {
        status: 403,
      });
    }
  } catch {
    return new Response("CSRF check failed — malformed Origin", { status: 403 });
  }
  return null;
}

/**
 * Check admin dashboard auth. Returns error Response or null if OK.
 *
 * Also runs the Origin-header CSRF check for mutating methods — cheaper
 * than requiring every individual route to call checkCsrf() separately,
 * and impossible to forget.
 *
 * Multi-token aware: `ADMIN_AUTH_TOKEN` / `MCP_AUTH_TOKEN` can be a
 * comma-separated list so one deployment can hand different tokens to
 * different clients. Fix shipped in v0.5 phase 13 after route tests
 * caught that the prior single-string compare broke multi-token setups.
 */
export async function checkAdminAuth(request: Request): Promise<Response | null> {
  return withSpan("auth.check", () => _checkAdminAuthImpl(request), {
    "auth.kind": "admin",
  });
}

async function _checkAdminAuthImpl(request: Request): Promise<Response | null> {
  // CSRF first — doesn't depend on token state, so no info leak.
  const csrfError = checkCsrf(request);
  if (csrfError) return csrfError;

  warnAdminTokenFallback();

  // SEC-A-03: refuse silent fallback in production. If MCP_AUTH_TOKEN is set
  // but ADMIN_AUTH_TOKEN is not, the dashboard would otherwise be reachable
  // with the same token every MCP client holds. That defeats the two-scope
  // model. To opt back into the legacy behavior (single token shared
  // between MCP + admin), set KEBAB_ADMIN_TOKEN_FALLBACK=1 explicitly.
  const adminTokenEnv = getConfig("ADMIN_AUTH_TOKEN");
  const mcpTokenEnv = getConfig("MCP_AUTH_TOKEN");
  const fallbackOptIn =
    getConfig("KEBAB_ADMIN_TOKEN_FALLBACK") === "1" ||
    getConfig("KEBAB_ADMIN_TOKEN_FALLBACK") === "true";
  const isProd = getConfig("NODE_ENV") === "production" || getConfig("VERCEL") === "1";
  if (isProd && !adminTokenEnv && mcpTokenEnv && !fallbackOptIn) {
    return new Response(
      "Admin auth misconfigured: ADMIN_AUTH_TOKEN is required when MCP_AUTH_TOKEN is set " +
        "(or set KEBAB_ADMIN_TOKEN_FALLBACK=1 to allow shared-token fallback).",
      { status: 503 }
    );
  }

  const adminRaw = adminTokenEnv || mcpTokenEnv || getBootstrapAuthToken() || "";
  const tokens = parseTokens(adminRaw);
  if (tokens.length === 0) {
    // First-run mode (no token configured anywhere). We must NOT silently
    // grant admin access to the public internet — that would let anyone seize
    // a fresh Vercel deploy. Allow access only when:
    //   (a) the request is from loopback (local dev), or
    //   (b) the request carries a valid first-run claim cookie (the user who
    //       initialized this instance via /welcome).
    if (isLoopbackRequest(request)) return null;
    try {
      if (await isClaimer(request)) return null;
    } catch {
      // SigningSecretUnavailableError or any other failure → deny.
    }
    return new Response("Unauthorized", { status: 401 });
  }

  const provided = extractToken(request);
  if (provided) {
    for (const t of tokens) {
      if (safeCompare(provided, t)) return null;
    }
  }

  return new Response("Unauthorized", { status: 401 });
}
