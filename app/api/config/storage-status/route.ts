import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import {
  detectStorageBackend,
  isUpstashConfigured,
  isVercelApiConfigured,
} from "@/core/credential-store";

/**
 * GET /api/config/storage-status
 * Returns current credential storage backend info.
 */
export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  return NextResponse.json({
    backend: detectStorageBackend(),
    upstashConfigured: isUpstashConfigured(),
    vercelApiConfigured: isVercelApiConfigured(),
    isVercel: process.env.VERCEL === "1",
  });
}
