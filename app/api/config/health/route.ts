import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { isFirstRunMode, isBootstrapActive } from "@/core/first-run";
import { isVercelAutoMagicAvailable } from "@/core/env-store";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

export const dynamic = "force-dynamic";

export type TokenStatus = "permanent" | "bootstrap" | "unconfigured";

export interface HealthResponse {
  ok: true;
  tokenStatus: TokenStatus;
  isVercel: boolean;
  vercelAutoMagicAvailable: boolean;
  instanceUrl: string;
}

/**
 * GET /api/config/health
 *
 * Admin-gated diagnostics for the dashboard health widget. Reports token
 * provenance (permanent vs in-memory bootstrap vs unconfigured) and whether
 * the Vercel auto-deploy path is available.
 */
async function getHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  let tokenStatus: TokenStatus;
  if (isFirstRunMode()) {
    tokenStatus = "unconfigured";
  } else if (isBootstrapActive()) {
    tokenStatus = "bootstrap";
  } else {
    tokenStatus = "permanent";
  }

  const isVercel = process.env.VERCEL === "1";
  const vercelAutoMagicAvailable = isVercelAutoMagicAvailable();

  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host") || "localhost:3000";
  const instanceUrl = `${proto}://${host}`;

  const body: HealthResponse = {
    ok: true,
    tokenStatus,
    isVercel,
    vercelAutoMagicAvailable,
    instanceUrl,
  };
  return NextResponse.json(body);
}

export const GET = withBootstrapRehydrate(getHandler);
