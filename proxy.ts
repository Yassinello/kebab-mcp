import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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

  const adminToken = (process.env.ADMIN_AUTH_TOKEN || process.env.MCP_AUTH_TOKEN)?.trim();
  const isFirstTimeSetup = !process.env.MCP_AUTH_TOKEN;

  // ── First-run: /setup is open, everything else redirects to /setup ─
  if (isFirstTimeSetup) {
    if (pathname === "/setup" || pathname.startsWith("/api/setup")) {
      return NextResponse.next();
    }
    if (pathname === "/" || pathname === "/config" || pathname.startsWith("/config/")) {
      return NextResponse.redirect(new URL("/setup", request.url));
    }
    return NextResponse.next();
  }

  // ── Post first-run: /setup → /config unless ?add= ───────────────────
  if (pathname === "/setup" && !request.nextUrl.searchParams.has("add")) {
    return NextResponse.redirect(new URL("/config", request.url));
  }
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/config", request.url));
  }

  // ── Auth-gated areas ────────────────────────────────────────────────
  const adminGated =
    pathname === "/config" ||
    pathname.startsWith("/config/") ||
    pathname.startsWith("/api/config/") ||
    pathname === "/setup" ||
    pathname === "/playground" ||
    pathname === "/packs";

  if (adminGated && !adminToken) {
    // Misconfiguration: admin surface exists but no token set.
    // Never fall through to serving the page unauthenticated.
    return new NextResponse(
      JSON.stringify({
        error: "Admin auth not configured. Set ADMIN_AUTH_TOKEN or MCP_AUTH_TOKEN.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (adminGated && adminToken) {
    if (!isAuthorized(request, adminToken)) {
      return new NextResponse(
        "Unauthorized — use Authorization header or ?token= to access the dashboard",
        { status: 401, headers: { "Content-Type": "text/plain" } }
      );
    }

    // If authorized via query token, set a cookie so subsequent page/API calls work
    const queryToken = request.nextUrl.searchParams.get("token")?.trim();
    if (queryToken && safeEqual(queryToken, adminToken)) {
      const res = NextResponse.next();
      res.cookies.set("mymcp_admin_token", adminToken, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });
      return res;
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/setup",
    "/playground",
    "/packs",
    "/config",
    "/config/:path*",
    "/api/config/:path*",
  ],
};
