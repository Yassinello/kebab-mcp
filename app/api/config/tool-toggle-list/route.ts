import { NextResponse } from "next/server";
import { getDisabledTools, getDisabledToolsForTenant } from "@/core/tool-toggles";
import { getTenantId, TenantError } from "@/core/tenant";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

/**
 * GET /api/config/tool-toggle-list
 *
 * Returns the list of currently disabled tool names. Auth-gated.
 * When x-mymcp-tenant header is present, returns tenant-scoped toggles.
 */
async function getHandler(ctx: PipelineContext) {
  const request = ctx.request;

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
    return NextResponse.json({ error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
