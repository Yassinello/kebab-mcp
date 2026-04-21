import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { checkAdminAuth } from "@/core/auth";
import { getEnabledPacks } from "@/core/registry";
import { withLogging } from "@/core/logging";
import { checkRateLimit } from "@/core/rate-limit";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * POST /api/config/sandbox
 * Body: { toolName: string, args: Record<string, unknown>, confirm?: boolean }
 * Admin-auth-gated. Rate limited to 20/min.
 */
async function postHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  // Rate limit using the shared KV-backed limiter (survives cold starts).
  // Identify by admin token or fallback to a fixed key.
  const authHeader = request.headers.get("authorization") || "sandbox-global";
  const rlResult = await checkRateLimit(authHeader, { scope: "sandbox", limit: 20 });
  if (!rlResult.allowed) {
    return NextResponse.json(
      { ok: false, error: "Rate limit exceeded (max 20 / minute)" },
      { status: 429 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    toolName?: string;
    args?: Record<string, unknown>;
    confirm?: boolean;
  } | null;

  if (!body || !body.toolName) {
    return NextResponse.json({ ok: false, error: "Missing toolName" }, { status: 400 });
  }

  const { toolName, args = {}, confirm = false } = body;

  // Look up tool in current registry
  const enabled = getEnabledPacks();
  for (const pack of enabled) {
    for (const tool of pack.manifest.tools) {
      if (tool.name === toolName) {
        if (tool.destructive && !confirm) {
          return NextResponse.json(
            { ok: false, error: "Destructive tool requires confirm: true" },
            { status: 400 }
          );
        }
        // Validate args against the tool's Zod schema before invoking.
        // ToolDefinition.schema is Record<string, ZodTypeAny>, so wrap it.
        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = z.object(tool.schema).parse(args) as Record<string, unknown>;
        } catch (err) {
          if (err instanceof ZodError) {
            return NextResponse.json(
              { ok: false, error: "Invalid arguments", issues: err.issues },
              { status: 400 }
            );
          }
          throw err;
        }

        const start = Date.now();
        try {
          // Route through withLogging so sandbox invocations appear in the Logs tab.
          const wrapped = withLogging(tool.name, tool.handler);
          const result = await wrapped(parsedArgs);
          return NextResponse.json({
            ok: true,
            data: result,
            durationMs: Date.now() - start,
          });
        } catch (err) {
          return NextResponse.json({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
          });
        }
      }
    }
  }

  return NextResponse.json(
    { ok: false, error: `Tool not found or not enabled: ${toolName}` },
    { status: 404 }
  );
}

export const POST = withBootstrapRehydrate(postHandler);
