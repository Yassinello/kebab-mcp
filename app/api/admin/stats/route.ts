import { checkAdminAuth } from "@/core/auth";
import { getToolStats } from "@/core/logging";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * Tool usage analytics (in-memory, ephemeral).
 * Returns aggregated stats: total calls, error rate, per-tool breakdown.
 */
async function getHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  const stats = getToolStats();

  return Response.json({
    ...stats,
    _ephemeral: "Stats are in-memory and reset on cold start.",
  });
}

export const GET = withBootstrapRehydrate(getHandler);
