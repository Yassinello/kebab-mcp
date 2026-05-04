import { NextResponse } from "next/server";
import { getCustomTool } from "@/connectors/custom-tools/store";
import { runCustomTool } from "@/connectors/custom-tools/runner";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/admin/custom-tools/:id/test
 *
 * Body: { inputs: Record<string, unknown> }
 * Returns: { ok, result, stepResults, totalDurationMs, error? }
 *
 * Server-side test runner: executes the persisted Custom Tool with
 * the supplied inputs, in process, with the same credential plumbing
 * the MCP transport uses. The dashboard calls this BEFORE save and
 * after save to verify behavior without going through the MCP client.
 *
 * The endpoint deliberately mirrors the runner's RunResult shape so
 * the UI can render a step-by-step trace.
 */
async function testHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;

  const tool = await getCustomTool(id);
  if (!tool) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  let body: unknown = {};
  try {
    body = await ctx.request.json();
  } catch {
    // Empty body is fine — tools with all-optional inputs need no body.
  }
  const inputs =
    body && typeof body === "object" && "inputs" in body
      ? ((body as { inputs?: Record<string, unknown> }).inputs ?? {})
      : {};

  try {
    const result = await runCustomTool(tool, inputs);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `runner crash: ${toMsg(err)}`,
        result: "",
        stepResults: [],
        totalDurationMs: 0,
      },
      { status: 500 }
    );
  }
}

export const POST = withAdminAuth(testHandler);
