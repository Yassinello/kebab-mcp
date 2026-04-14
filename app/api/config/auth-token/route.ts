import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";

/**
 * GET /api/config/auth-token
 *
 * Returns the first token from MCP_AUTH_TOKEN to admin-authed callers.
 * Used by the Settings → MCP install panel's "Reveal" button instead of
 * server-rendering the token into the page payload (which would leak it
 * into HTML view-source even when the UI shows it masked).
 *
 * Auth: same as other admin routes — admin cookie or Authorization header.
 * Returns 404 (not 200 with empty body) when no token is configured, so
 * an attacker who manages to bypass auth still has to differentiate
 * "token-less server" from "wrong creds" without an oracle.
 */
export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  const token = (process.env.MCP_AUTH_TOKEN || "").split(",")[0]?.trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "No token configured" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, token });
}
