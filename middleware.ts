import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Protect admin routes — dashboard and setup
  const adminToken = (
    process.env.ADMIN_AUTH_TOKEN || process.env.MCP_AUTH_TOKEN
  )?.trim();

  const protectedPaths = ["/", "/setup", "/playground"];
  if (protectedPaths.includes(pathname) && adminToken) {
    const queryToken = request.nextUrl.searchParams.get("token")?.trim();
    const authHeader = request.headers.get("authorization");
    const bearer = authHeader?.replace(/^Bearer\s+/i, "").trim();

    if (bearer !== adminToken && queryToken !== adminToken) {
      return new NextResponse(
        "Unauthorized — use Authorization header or ?token= to access the dashboard",
        { status: 401, headers: { "Content-Type": "text/plain" } }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/setup", "/playground"],
};
