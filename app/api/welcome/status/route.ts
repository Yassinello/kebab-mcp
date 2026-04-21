import { NextResponse } from "next/server";
import { isFirstRunMode, isBootstrapActive } from "@/core/first-run";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * GET /api/welcome/status
 *
 * Polled by the welcome page to detect when the user has finished pasting
 * their token into Vercel and triggered a redeploy. At that point
 * MCP_AUTH_TOKEN is set "for real" and isBootstrapActive() returns false.
 */
async function getHandler(_request: Request) {
  const initialized = !isFirstRunMode();
  const isBootstrap = isBootstrapActive();
  const permanent = initialized && !isBootstrap;
  return NextResponse.json({ initialized, permanent, isBootstrap });
}

export const GET = withBootstrapRehydrate(getHandler);
