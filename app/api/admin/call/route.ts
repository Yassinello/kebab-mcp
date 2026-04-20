import { checkAdminAuth } from "@/core/auth";
import { getEnabledPacks } from "@/core/registry";
import { withLogging } from "@/core/logging";
import { requestContext } from "@/core/request-context";
import { getTenantId } from "@/core/tenant";

/**
 * Tool call playground API — test any tool from the dashboard.
 * Requires ADMIN_AUTH_TOKEN. Returns the tool's raw response.
 *
 * SEC-03: tool invocation is wrapped in `requestContext.run` so tool
 * handlers that read the tenantId (via `getCurrentTenantId()`) and rely
 * on `getContextKVStore()` see the same tenant isolation as the MCP
 * transport. Without this wrap, playground calls silently operate on
 * the untenanted KV namespace even when called from a tenant-aware
 * dashboard session. See .planning/research/RISKS-AUDIT.md finding #4.
 */
export async function POST(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  // Resolve tenantId from the x-mymcp-tenant header (null = default).
  // Invalid header shape → 400 via TenantError.
  let tenantId: string | null;
  try {
    tenantId = getTenantId(request);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid tenant header" },
      { status: 400 }
    );
  }

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
    const result = await requestContext.run({ tenantId }, () => handler(params || {}));
    return Response.json({ result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Tool execution failed" },
      { status: 500 }
    );
  }
}
