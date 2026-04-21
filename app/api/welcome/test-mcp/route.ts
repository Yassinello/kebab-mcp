import { NextResponse } from "next/server";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

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
async function postHandler(request: Request) {
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
      error: err instanceof Error ? err.message : "Network error calling /api/mcp",
    });
  }
}

export const POST = withBootstrapRehydrate(postHandler);
