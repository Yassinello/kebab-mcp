import { checkAdminAuth } from "@/core/auth";
import { getEnabledPacks } from "@/core/registry";
import { withLogging } from "@/core/logging";

/**
 * Tool call playground API — test any tool from the dashboard.
 * Requires ADMIN_AUTH_TOKEN. Returns the tool's raw response.
 */
export async function POST(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  const body = await request.json();
  const { tool: toolName, params } = body as { tool: string; params: Record<string, unknown> };

  if (!toolName) {
    return Response.json({ error: "Missing 'tool' field" }, { status: 400 });
  }

  // Find the tool in enabled packs
  const enabledPacks = getEnabledPacks();
  let toolDef = null;
  for (const pack of enabledPacks) {
    const found = pack.manifest.tools.find((t) => t.name === toolName);
    if (found) {
      toolDef = found;
      break;
    }
  }

  if (!toolDef) {
    return Response.json(
      { error: `Tool '${toolName}' not found or pack is disabled` },
      { status: 404 }
    );
  }

  try {
    const handler = withLogging(toolName, async (p: Record<string, unknown>) =>
      toolDef!.handler(p)
    );
    const result = await handler(params || {});
    return Response.json({ result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Tool execution failed" },
      { status: 500 }
    );
  }
}
