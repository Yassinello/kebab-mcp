import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { readWeekUsage, recentWeeks, usageCountersEnabled } from "@/core/usage";

/**
 * Kebab House phase 0 (USE-03) — GET /api/config/usage?weeks=N (1..12).
 * Newest week first. Names and counts only.
 */
async function getHandler(ctx: PipelineContext): Promise<Response> {
  const raw = Number(new URL(ctx.request.url).searchParams.get("weeks") ?? "2");
  const n = Number.isFinite(raw) ? Math.min(12, Math.max(1, Math.trunc(raw))) : 2;
  const weeks = await Promise.all(recentWeeks(n).map((w) => readWeekUsage(w)));
  return NextResponse.json(
    { enabled: usageCountersEnabled(), weeks },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export const GET = withAdminAuth(getHandler);
