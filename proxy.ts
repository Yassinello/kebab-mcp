import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ensureBootstrapRehydratedFromUpstash } from "@/core/first-run-edge";

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

/**
 * Constant-time string comparison without an early length side-channel.
 *
 * v0.6 LOW: the previous implementation returned early on length
 * mismatch, which leaks the length of the expected admin token through
 * response timing. We now always walk the full length of the LONGER
 * input, XOR-accumulating into the same accumulator and mixing in the
 * length delta so unequal lengths still produce a non-zero result.
 * `crypto.timingSafeEqual` isn't available on the Edge runtime, so we
 * stay with the manual loop. A sha256-digest-based variant was
 * considered but adds an async barrier the middleware can't tolerate
 * on its synchronous auth path.
 */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    result |= ca ^ cb;
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

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rehydrate MCP_AUTH_TOKEN from Upstash when the current lambda doesn't
  // have it in process.env yet. Without this, a cold lambda that hasn't
  // served any welcome/handler traffic (which would have rehydrated via
  // first-run.ts) sees MCP_AUTH_TOKEN as undefined and incorrectly treats
  // /config as first-time-setup — redirecting to /welcome and locking the
  // user out of their own dashboard. The helper short-circuits when the
  // env var is already present, so warm lambdas pay no cost.
  await ensureBootstrapRehydratedFromUpstash();

  // ── CSP nonce + header setup ───────────────────────────────────────
  // Done first so every return path below inherits the nonce/CSP via
  // the `finalize` helper. The nonce is propagated to the React tree
  // through the `x-nonce` request header (read server-side by the root
  // layout and passed to <Script nonce=…>).
  const nonce = generateNonce();
  const csp = buildCsp(nonce);
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();

  // Build a request-headers delta so the app can read `x-nonce` and `x-request-id`.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-request-id", requestId);

  const finalize = (res: NextResponse): NextResponse => {
    res.headers.set("Content-Security-Policy", csp);
    res.headers.set("x-request-id", requestId);
    return res;
  };
  const passthrough = () => finalize(NextResponse.next({ request: { headers: requestHeaders } }));

  const adminToken = (process.env.ADMIN_AUTH_TOKEN || process.env.MCP_AUTH_TOKEN)?.trim();
  const isShowcase = process.env.INSTANCE_MODE === "showcase";
  const isFirstTimeSetup = !process.env.MCP_AUTH_TOKEN && !isShowcase;

  // ── Showcase: public template deploy, no MCP endpoint, no admin. ─────
  // / serves the landing page; /welcome and /config are meaningless here
  // (no token to configure, no instance to admin) so we send them home.
  if (isShowcase) {
    if (pathname === "/welcome" || pathname === "/config" || pathname.startsWith("/config/")) {
      return finalize(NextResponse.redirect(new URL("/", request.url)));
    }
    return passthrough();
  }

  // ── First-run: /welcome is the entry point, everything else redirects ─
  if (isFirstTimeSetup) {
    if (pathname === "/setup" || pathname.startsWith("/api/setup")) {
      return passthrough();
    }
    if (pathname === "/" || pathname === "/config" || pathname.startsWith("/config/")) {
      return finalize(NextResponse.redirect(new URL("/welcome", request.url)));
    }
    return passthrough();
  }

  // ── Post first-run: /setup always redirects to /config ──────────────
  if (pathname === "/setup") {
    return finalize(NextResponse.redirect(new URL("/config?tab=connectors", request.url)));
  }
  if (pathname === "/" && process.env.INSTANCE_MODE === "personal") {
    return finalize(NextResponse.redirect(new URL("/config", request.url)));
  }

  // ── Auth-gated areas ────────────────────────────────────────────────
  const adminGated =
    pathname === "/config" ||
    pathname.startsWith("/config/") ||
    pathname.startsWith("/api/config/") ||
    pathname === "/setup"; // legacy: still gate it in case someone hits it before redirect

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

    // If authorized via query token, set the cookie AND redirect to the
    // same path with `?token=` stripped. Two wins: (1) the token doesn't
    // linger in browser history / Referer headers / shared URLs, (2) the
    // URL bar is clean for the user who just finished /welcome and
    // clicked "Open dashboard". Browser follows the redirect with the
    // freshly-set cookie, second hit passes the auth check without the
    // query param.
    const queryToken = request.nextUrl.searchParams.get("token")?.trim();
    if (queryToken && safeEqual(queryToken, adminToken)) {
      const cleanUrl = new URL(request.url);
      cleanUrl.searchParams.delete("token");
      const res = finalize(NextResponse.redirect(cleanUrl));
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
      return res;
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
