import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { getEnabledPacksLazy } from "@/core/registry";
import { withLogging } from "@/core/logging";
import { checkRateLimit } from "@/core/rate-limit";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

/**
 * POST /api/config/sandbox
 * Body: { toolName: string, args: Record<string, unknown>, confirm?: boolean }
 * Admin-auth-gated. Rate limited to 20/min.
 */
async function postHandler(ctx: PipelineContext) {
  const request = ctx.request;

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

  // Look up tool in current registry (PERF-01: lazy resolve).
  const enabled = await getEnabledPacksLazy();
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
            error: toMsg(err),
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

export const POST = withAdminAuth(postHandler);
