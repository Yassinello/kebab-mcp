import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { labelClients } from "@/connectors/house/tools/house-tools";
import { readWeekUsage, recentWeeks, usageCountersEnabled } from "@/core/usage";

/**
 * Kebab House phase 0 (USE-03) — GET /api/config/usage?weeks=N (1..12).
 * Newest week first. Names and counts only.
 */
async function getHandler(ctx: PipelineContext): Promise<Response> {
  const raw = Number(new URL(ctx.request.url).searchParams.get("weeks") ?? "2");
  const n = Number.isFinite(raw) ? Math.min(12, Math.max(1, Math.trunc(raw))) : 2;
  const raw2 = await Promise.all(recentWeeks(n).map((w) => readWeekUsage(w)));
  // Show device labels and "Admin key" instead of token hashes.
  const weeks = await Promise.all(
    raw2.map(async (w) => ({ ...w, clients: await labelClients(w.clients) }))
  );
  return NextResponse.json(
    { enabled: usageCountersEnabled(), weeks },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export const GET = withAdminAuth(getHandler);
