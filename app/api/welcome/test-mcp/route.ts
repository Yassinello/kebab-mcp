import { NextResponse } from "next/server";
import {
  composeRequestPipeline,
  rehydrateStep,
  rateLimitStep,
  type PipelineContext,
} from "@/core/pipeline";
import { checkAdminAuth } from "@/core/auth";
import { isClaimer } from "@/core/first-run";
import { isLoopbackRequest } from "@/core/request-utils";

/**
 * SEC-15 (2026-11 audit): this endpoint replays a caller-supplied token
 * against /api/mcp — unauthenticated it was a token-validity oracle that
 * bypassed the MCP rate limit. Only the welcome claimer, an admin, or a
 * loopback caller may use it; it is also rate-limited per IP.
 */
async function isAllowedCaller(request: Request): Promise<boolean> {
  if (isLoopbackRequest(request)) return true;
  // silent-swallow-ok: SigningSecretUnavailableError means no claim can be proven; admin auth below is the fallback
  try {
    if (await isClaimer(request)) return true;
  } catch {
    // Signing secret unavailable → fall through to admin auth.
  }
  return (await checkAdminAuth(request)) === null;
}

/**
 * POST /api/welcome/test-mcp
 *
 * Server-side probe: hits this instance's /api/mcp endpoint with the provided
 * token and reports whether auth + the MCP handler are wired up. Used by the
 * welcome page to gate the "Continue to Dashboard" button behind a proven
 * end-to-end install.
 *
 * Body: { token: string }
 * Response: { ok, authPassed, status, toolsCount?, error? }
 */
async function postHandler(ctx: PipelineContext) {
  const request = ctx.request;
  if (!(await isAllowedCaller(request))) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  let token: string | undefined;
  try {
    const body = (await request.json()) as { token?: string };
    token = body.token?.trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!token) {
    return NextResponse.json({ ok: false, error: "Missing token" }, { status: 400 });
  }

  const origin = new URL(request.url).origin;
  const mcpUrl = `${origin}/api/mcp`;

  const initPayload = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kebab-mcp-welcome-test", version: "1.0.0" },
    },
  };

  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(initPayload),
    });

    if (res.status === 401) {
      return NextResponse.json({
        ok: false,
        authPassed: false,
        status: 401,
        error:
          "Token rejected (401). The permanent token is not yet active in Vercel — wait for the redeploy to finish.",
      });
    }

    // mcp-handler replies 200 (JSON) or 202 (SSE stream) on a successful
    // initialize. Anything else in 2xx still proves auth passed.
    if (res.ok) {
      return NextResponse.json({ ok: true, authPassed: true, status: res.status });
    }

    return NextResponse.json({
      ok: false,
      authPassed: true,
      status: res.status,
      error: `MCP endpoint returned ${res.status}`,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      // Do not echo raw fetch errors (internal hostnames / addresses).
      error: err instanceof Error ? "Network error calling /api/mcp" : "Network error",
    });
  }
}

export const POST = composeRequestPipeline(
  [rehydrateStep, rateLimitStep({ scope: "welcome-test", keyFrom: "ip", limit: 10 })],
  postHandler
);
