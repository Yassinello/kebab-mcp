import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { setToolDisabled } from "@/core/tool-toggles";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * POST /api/config/tool-toggle
 *
 * Toggle a tool on or off. Auth-gated (admin token required).
 * Body: { tool: string, disabled: boolean }
 * Writes to KV + emits env.changed to invalidate registry.
 */
async function postHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  let body: { tool?: string; disabled?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const toolName = body.tool;
  const disabled = body.disabled;

  if (!toolName || typeof toolName !== "string") {
    return NextResponse.json({ error: "Missing or invalid 'tool' field" }, { status: 400 });
  }
  if (typeof disabled !== "boolean") {
    return NextResponse.json(
      { error: "Missing or invalid 'disabled' field (boolean)" },
      { status: 400 }
    );
  }

  try {
    await setToolDisabled(toolName, disabled);
    return NextResponse.json({
      ok: true,
      tool: toolName,
      disabled,
      message: `Tool ${toolName} is now ${disabled ? "disabled" : "enabled"}.`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export const POST = withBootstrapRehydrate(postHandler);
