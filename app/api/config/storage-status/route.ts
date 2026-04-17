import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { isClaimer } from "@/core/first-run";
import { isLoopbackRequest } from "@/core/request-utils";
import {
  detectStorageBackend,
  isUpstashConfigured,
  isVercelApiConfigured,
} from "@/core/credential-store";

/**
 * GET /api/config/storage-status
 * Returns current credential storage backend info.
 *
 * Auth: admin auth when MCP_AUTH_TOKEN is set; otherwise accept
 * first-run claimer or loopback (same pattern as /api/setup/test).
 */
export async function GET(request: Request) {
  if (process.env.MCP_AUTH_TOKEN) {
    const authError = checkAdminAuth(request);
    if (authError) return authError;
  } else {
    if (!isLoopbackRequest(request) && !isClaimer(request)) {
      return NextResponse.json(
        { error: "Unauthorized — claim this instance via /welcome first" },
        { status: 401 }
      );
    }
  }

  return NextResponse.json({
    backend: detectStorageBackend(),
    upstashConfigured: isUpstashConfigured(),
    vercelApiConfigured: isVercelApiConfigured(),
    isVercel: process.env.VERCEL === "1",
  });
}
