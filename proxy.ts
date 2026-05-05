import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  ensureBootstrapRehydratedFromUpstash,
  getEdgeBootstrapAuthToken,
} from "@/core/first-run-edge";

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

/**
 * HTML-escape a string for safe interpolation inside the sign-in page.
 * Keep tiny — only the characters we might render (no full sanitizer).
 */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render a self-contained sign-in page when an unauthenticated browser
 * lands on /config or /config/*. Replaces the prior text/plain 401 that
 * left users stranded with no recoverable action.
 *
 * Keeps the response status at 401 so clients (curl, fetch) still see
 * the auth gate, but humans get a usable form. Style is inline so we
 * stay edge-runtime-friendly (no asset pipeline, no React).
 *
 * The form GETs back to the same path with `?token=...` — the existing
 * auth handler downstream picks it up, sets the cookie, redirects to a
 * clean URL.
 */
function renderSignInPage(returnPath: string): string {
  const safeReturn = escHtml(returnPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Kebab MCP</title>
<style>
  :root {
    --bg: #fafaf7;
    --fg: #1c1c1c;
    --muted: #6b7280;
    --border: #e5e5e0;
    --accent: #d97706;
    --accent-hover: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0c0c0c; --fg: #f5f5f0; --muted: #9ca3af; --border: #2a2a26; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    width: 100%;
    max-width: 420px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
  }
  .logo { font-size: 32px; line-height: 1; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0 0 8px; font-weight: 600; }
  p { margin: 0 0 20px; color: var(--muted); font-size: 14px; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
  input[type="password"] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font: inherit;
    background: var(--bg);
    color: var(--fg);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
  }
  input[type="password"]:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.15);
  }
  button {
    margin-top: 16px;
    width: 100%;
    padding: 10px 16px;
    background: var(--accent);
    color: white;
    border: 0;
    border-radius: 8px;
    font: inherit;
    font-weight: 500;
    cursor: pointer;
  }
  button:hover { background: var(--accent-hover); }
  details { margin-top: 24px; font-size: 13px; color: var(--muted); }
  summary { cursor: pointer; font-weight: 500; color: var(--fg); }
  details ul { padding-left: 20px; margin: 8px 0 0; }
  details li { margin-bottom: 4px; }
  details a { color: var(--accent); }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    background: var(--border);
    padding: 1px 5px;
    border-radius: 4px;
  }
</style>
</head>
<body>
<main class="card">
  <div class="logo">🥙</div>
  <h1>Sign in to Kebab MCP</h1>
  <p>Paste your admin token to access the dashboard.</p>
  <form method="get" action="${safeReturn}" autocomplete="off">
    <label for="token">Admin token</label>
    <input
      id="token"
      name="token"
      type="password"
      placeholder="kebab-mcp_..."
      required
      autofocus
      spellcheck="false"
      autocapitalize="none"
    >
    <button type="submit">Sign in</button>
  </form>
  <details>
    <summary>Lost your token?</summary>
    <ul>
      <li>Check your Vercel project → <em>Settings → Environment Variables</em> for <code>ADMIN_AUTH_TOKEN</code> or <code>MCP_AUTH_TOKEN</code>.</li>
      <li>If this is a fresh install, go to <a href="/welcome">/welcome</a> to mint a new token.</li>
      <li>If you set up Upstash KV, your token is also stored there under <code>bootstrap:auth-token</code>.</li>
    </ul>
  </details>
</main>
</body>
</html>`;
}

function isAuthorized(request: NextRequest, adminToken: string): boolean {
  const queryToken = request.nextUrl.searchParams.get("token")?.trim() || "";
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.replace(/^Bearer\s+/i, "").trim() || "";
  // Phase 50 / BRAND-02: kebab_admin_token is the modern cookie name;
  // mymcp_admin_token remains accepted during the 2-release transition.
  const kebabCookie = request.cookies.get("kebab_admin_token")?.value || "";
  const legacyCookie = request.cookies.get("mymcp_admin_token")?.value || "";
  return (
    safeEqual(bearer, adminToken) ||
    safeEqual(queryToken, adminToken) ||
    safeEqual(kebabCookie, adminToken) ||
    safeEqual(legacyCookie, adminToken)
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

  // SEC-02: the Edge rehydrate helper populates a module-scope cache
  // (edgeBootstrapAuthTokenCache) instead of mutating process.env. Derive
  // the effective token by consulting the cache as a fallback for the
  // KV-only persistence path (no auto-magic Vercel env write). Without
  // this, isFirstTimeSetup is always true on cold lambdas whose
  // process.env.MCP_AUTH_TOKEN wasn't injected as a real platform env var.
  const edgeBootstrapToken = getEdgeBootstrapAuthToken();
  const effectiveAuthToken =
    process.env.ADMIN_AUTH_TOKEN?.trim() ||
    process.env.MCP_AUTH_TOKEN?.trim() ||
    edgeBootstrapToken ||
    "";
  const adminToken = effectiveAuthToken;
  const isShowcase = process.env.INSTANCE_MODE === "showcase";
  const isFirstTimeSetup = !effectiveAuthToken && !isShowcase;

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
      // For browser-facing dashboard paths, render an HTML sign-in page so
      // the user has a recoverable action instead of a dead-end 401. JSON
      // API consumers (curl, fetch, MCP clients hitting /api/config/*)
      // still get a machine-friendly text response so they fail loudly.
      const isApiPath = pathname.startsWith("/api/");
      if (isApiPath) {
        return finalize(
          new NextResponse(
            "Unauthorized — use Authorization header or ?token= to access the dashboard",
            { status: 401, headers: { "Content-Type": "text/plain" } }
          )
        );
      }
      // Strip any existing `?token=` from the return path — the form
      // submits a fresh value and we don't want to leak the bad one back.
      const returnUrl = new URL(request.url);
      returnUrl.searchParams.delete("token");
      const returnPath = returnUrl.pathname + returnUrl.search;
      return finalize(
        new NextResponse(renderSignInPage(returnPath), {
          status: 401,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
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
      // Phase 50 / BRAND-02: dual-write the admin cookie under both the
      // modern `kebab_admin_token` and legacy `mymcp_admin_token` names.
      // Existing sessions with only the legacy cookie keep working during
      // the 2-release transition; new sessions are recognized by either.
      // Strict: the dashboard is never legitimately loaded by following a
      // link from another site. Blocks the CSRF vector on PUT /api/config/env
      // even without a CSRF token.
      const cookieOpts = {
        httpOnly: true,
        sameSite: "strict" as const,
        secure: true,
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      };
      res.cookies.set("kebab_admin_token", adminToken, cookieOpts);
      res.cookies.set("mymcp_admin_token", adminToken, cookieOpts);
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
