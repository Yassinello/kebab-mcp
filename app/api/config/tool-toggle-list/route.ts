import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { getDisabledTools, getDisabledToolsForTenant } from "@/core/tool-toggles";
import { getTenantId, TenantError } from "@/core/tenant";

/**
 * GET /api/config/tool-toggle-list
 *
 * Returns the list of currently disabled tool names. Auth-gated.
 * When x-mymcp-tenant header is present, returns tenant-scoped toggles.
 */
export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  let tenantId: string | null = null;
  try {
    tenantId = getTenantId(request);
  } catch (err) {
    if (err instanceof TenantError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
  }

  try {
    const disabled = tenantId
      ? await getDisabledToolsForTenant(tenantId)
      : await getDisabledTools();
    return NextResponse.json({ ok: true, disabled: Array.from(disabled) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
