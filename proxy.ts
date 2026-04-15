import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Build the per-request Content-Security-Policy header.
 *
 * Nonce-based: Next 16 inlines a small runtime bootstrap in every HTML
 * document, so `script-src` must allow either `'unsafe-inline'` or a
 * nonce that Next echoes back into those `<script>` tags. We pick the
 * nonce here in middleware, propagate it via the `x-nonce` request
 * header into the React tree (root layout reads it with `headers()`
 * and passes it to `<Script nonce=…>` where applicable), and set the
 * response header in one shot.
 *
 * In dev we keep `'unsafe-inline'` because Next's Fast Refresh runtime
 * injects scripts without the nonce; stripping it would brick HMR. In
 * prod we drop it entirely.
 */
function buildCsp(nonce: string): string {
  const upstashOrigin = (() => {
    try {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      if (!url) return "";
      return new URL(url).origin;
    } catch {
      return "";
    }
  })();
  const connectSrc = ["'self'", upstashOrigin].filter(Boolean).join(" ");
  const isDev = process.env.NODE_ENV === "development";
  // Tailwind v4 injects runtime styles — 'unsafe-inline' stays on styles.
  const scriptSrc = isDev
    ? `'self' 'unsafe-inline' 'nonce-${nonce}'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSrc}`,
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * Generate a base64 nonce. Edge Runtime doesn't expose Node's `crypto`
 * module reliably, so we use Web Crypto's getRandomValues which is
 * available in both Node and Edge.
 */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Base64 encode without relying on Buffer (Edge-safe).
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Constant-time comparison (Edge Runtime compatible — no crypto.timingSafeEqual)
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function isAuthorized(request: NextRequest, adminToken: string): boolean {
  const queryToken = request.nextUrl.searchParams.get("token")?.trim() || "";
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.replace(/^Bearer\s+/i, "").trim() || "";
  const cookieToken = request.cookies.get("mymcp_admin_token")?.value || "";
  return (
    safeEqual(bearer, adminToken) ||
    safeEqual(queryToken, adminToken) ||
    safeEqual(cookieToken, adminToken)
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── CSP nonce + header setup ───────────────────────────────────────
  // Done first so every return path below inherits the nonce/CSP via
  // the `finalize` helper. The nonce is propagated to the React tree
  // through the `x-nonce` request header (read server-side by the root
  // layout and passed to <Script nonce=…>).
  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // Build a request-headers delta so the app can read `x-nonce`.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const finalize = (res: NextResponse): NextResponse => {
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };
  const passthrough = () => finalize(NextResponse.next({ request: { headers: requestHeaders } }));

  const adminToken = (process.env.ADMIN_AUTH_TOKEN || process.env.MCP_AUTH_TOKEN)?.trim();
  const isFirstTimeSetup = !process.env.MCP_AUTH_TOKEN;

  // ── First-run: /setup is open, everything else redirects to /setup ─
  if (isFirstTimeSetup) {
    if (pathname === "/setup" || pathname.startsWith("/api/setup")) {
      return passthrough();
    }
    if (pathname === "/" || pathname === "/config" || pathname.startsWith("/config/")) {
      return finalize(NextResponse.redirect(new URL("/setup", request.url)));
    }
    return passthrough();
  }

  // ── Post first-run: /setup → /config unless ?add= ───────────────────
  if (pathname === "/setup" && !request.nextUrl.searchParams.has("add")) {
    return finalize(NextResponse.redirect(new URL("/config", request.url)));
  }
  if (pathname === "/" && process.env.INSTANCE_MODE === "personal") {
    return finalize(NextResponse.redirect(new URL("/config", request.url)));
  }

  // ── Auth-gated areas ────────────────────────────────────────────────
  const adminGated =
    pathname === "/config" ||
    pathname.startsWith("/config/") ||
    pathname.startsWith("/api/config/") ||
    pathname === "/setup";

  if (adminGated && !adminToken) {
    // Misconfiguration: admin surface exists but no token set.
    // Never fall through to serving the page unauthenticated.
    return finalize(
      new NextResponse(
        JSON.stringify({
          error: "Admin auth not configured. Set ADMIN_AUTH_TOKEN or MCP_AUTH_TOKEN.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    );
  }

  if (adminGated && adminToken) {
    if (!isAuthorized(request, adminToken)) {
      return finalize(
        new NextResponse(
          "Unauthorized — use Authorization header or ?token= to access the dashboard",
          { status: 401, headers: { "Content-Type": "text/plain" } }
        )
      );
    }

    // If authorized via query token, set a cookie so subsequent page/API calls work
    const queryToken = request.nextUrl.searchParams.get("token")?.trim();
    if (queryToken && safeEqual(queryToken, adminToken)) {
      const res = NextResponse.next({ request: { headers: requestHeaders } });
      res.cookies.set("mymcp_admin_token", adminToken, {
        httpOnly: true,
        // Strict: the dashboard is never legitimately loaded by following a
        // link from another site. Blocks the CSRF vector on PUT /api/config/env
        // even without a CSRF token.
        sameSite: "strict",
        secure: true,
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });
      return finalize(res);
    }
  }

  return passthrough();
}

/**
 * Matcher: we need CSP on every HTML response (so the nonce reaches the
 * React tree) AND we need the original auth logic to keep firing on
 * /config and /setup. Exclude Next internals and static assets so the
 * middleware doesn't fire for every JS chunk.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/|.*\\..*).*)", "/api/config/:path*"],
};
