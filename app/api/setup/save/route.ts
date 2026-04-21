import { NextResponse } from "next/server";
import { getEnvStore } from "@/core/env-store";
import { checkAdminAuth } from "@/core/auth";
import { isLoopbackRequest } from "@/core/request-utils";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * POST /api/setup/save
 * Writes env vars during first-time setup (filesystem only).
 *
 * Auth model:
 * - On Vercel: blocked — use /api/config/env with VERCEL_TOKEN, or set env in dashboard.
 * - Local, no MCP_AUTH_TOKEN yet: open (first-run).
 * - Local, MCP_AUTH_TOKEN present: caller must provide it via Authorization header
 *   (same as admin auth). Typically used by the wizard for the second write
 *   (pack credentials) after the first write established the token.
 */
async function postHandler(request: Request) {
  const isFirstRun = !process.env.MCP_AUTH_TOKEN;

  if (process.env.VERCEL === "1") {
    // On Vercel, first-run via this endpoint is disabled entirely: operators
    // must set MCP_AUTH_TOKEN in the Vercel dashboard first, then use
    // /api/config/env with admin auth for subsequent writes.
    return NextResponse.json(
      {
        error:
          "First-run setup via /api/setup/save is disabled on Vercel. Set MCP_AUTH_TOKEN in the Vercel dashboard first, then use /api/config/env (requires VERCEL_TOKEN + VERCEL_PROJECT_ID).",
      },
      { status: 403 }
    );
  }

  if (isFirstRun) {
    // No token yet — only accept local/loopback requests to prevent remote
    // attackers from seizing the admin token on a 0.0.0.0-bound dev server.
    if (!isLoopbackRequest(request)) {
      return NextResponse.json(
        {
          error:
            "First-run setup only accepts loopback (localhost) requests. Open the setup wizard on the machine running Kebab MCP.",
        },
        { status: 403 }
      );
    }
  } else {
    // Post first-run: standard admin auth.
    const authError = await checkAdminAuth(request);
    if (authError) return authError;
  }

  const body = (await request.json().catch(() => null)) as {
    envVars?: Record<string, string>;
  } | null;
  if (!body || !body.envVars || typeof body.envVars !== "object") {
    return NextResponse.json({ error: "Missing envVars object" }, { status: 400 });
  }

  // Validate keys
  for (const k of Object.keys(body.envVars)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) {
      return NextResponse.json({ error: `Invalid env var key: ${k}` }, { status: 400 });
    }
  }

  // Validate MCP_AUTH_TOKEN: each comma-separated segment must be >= 16 chars
  const rawMcpToken = body.envVars["MCP_AUTH_TOKEN"];
  if (rawMcpToken !== undefined && rawMcpToken !== "") {
    const segments = rawMcpToken
      .split(",")
      .map((t: string) => t.trim())
      .filter((t: string) => t.length > 0);
    const short = segments.filter((t: string) => t.length < 16);
    if (short.length > 0) {
      return NextResponse.json(
        {
          error: `MCP_AUTH_TOKEN: each token must be at least 16 characters (${short.length} segment(s) too short)`,
        },
        { status: 400 }
      );
    }
  }

  try {
    const store = getEnvStore();
    const result = await store.write(body.envVars);
    return NextResponse.json({
      ok: true,
      message: result.note || ".env saved.",
      written: result.written,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export const POST = withBootstrapRehydrate(postHandler);
