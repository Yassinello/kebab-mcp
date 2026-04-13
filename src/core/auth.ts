import { timingSafeEqual } from "crypto";

/**
 * Auth utilities for MyMCP.
 *
 * Two auth scopes:
 * - MCP auth: protects the /api/mcp endpoint (MCP_AUTH_TOKEN)
 * - Admin auth: protects the dashboard/setup UI (ADMIN_AUTH_TOKEN, falls back to MCP_AUTH_TOKEN)
 */

let adminTokenWarned = false;

function warnAdminTokenFallback() {
  if (adminTokenWarned) return;
  if (!process.env.ADMIN_AUTH_TOKEN && !process.env.MCP_AUTH_TOKEN) {
    console.warn(
      "[MyMCP Security] No auth tokens configured. Admin dashboard is publicly accessible."
    );
    adminTokenWarned = true;
  } else if (!process.env.ADMIN_AUTH_TOKEN && process.env.MCP_AUTH_TOKEN) {
    console.warn(
      "[MyMCP Security] ADMIN_AUTH_TOKEN is not set. Falling back to MCP_AUTH_TOKEN for admin access. " +
        "Set a separate ADMIN_AUTH_TOKEN for better security isolation."
    );
    adminTokenWarned = true;
  }
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function extractToken(request: Request): string | null {
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
  // Dashboard fetches from the browser rely on this.
  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)mymcp_admin_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]).trim();
  }

  return null;
}

/** Check MCP endpoint auth. Returns error Response or null if OK. */
export function checkMcpAuth(request: Request): Response | null {
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  if (!token) return null; // No token configured = open access

  const provided = extractToken(request);
  if (provided && safeCompare(provided, token)) return null;

  return new Response("Unauthorized", { status: 401 });
}

/** Check admin dashboard auth. Returns error Response or null if OK. */
export function checkAdminAuth(request: Request): Response | null {
  warnAdminTokenFallback();
  const token = (process.env.ADMIN_AUTH_TOKEN || process.env.MCP_AUTH_TOKEN)?.trim();
  if (!token) return null;

  const provided = extractToken(request);
  if (provided && safeCompare(provided, token)) return null;

  return new Response("Unauthorized", { status: 401 });
}
