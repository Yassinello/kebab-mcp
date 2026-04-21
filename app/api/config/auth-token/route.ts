import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * GET /api/config/auth-token
 *
 * Returns the first token from MCP_AUTH_TOKEN to admin-authed callers.
 * Used by the Settings → MCP install panel's "Reveal" button instead of
 * server-rendering the token into the page payload (which would leak it
 * into HTML view-source even when the UI shows it masked).
 *
 * Auth: same as other admin routes — admin cookie or Authorization header.
 *
 * v0.6 NIT-01: previously returned 404 for "no token configured" and 401
 * for "wrong creds" — that's an oracle (an attacker could differentiate
 * "token-less server" from "wrong token"). Both states now return 401 so
 * an unauthorized caller cannot tell them apart.
 */
async function getHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  const token = (process.env.MCP_AUTH_TOKEN || "").split(",")[0]?.trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, token });
}

export const GET = withBootstrapRehydrate(getHandler);
