import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { getToolStats, getRecentLogs } from "@/core/logging";
import { getLogStore } from "@/core/log-store";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * GET /api/admin/metrics
 *
 * Aggregate tool-call metrics from the in-memory ring buffer.
 * Unblocks "by-tool latency + error rate" dashboard widgets and external
 * monitoring polls.
 *
 * Response shape:
 *   {
 *     totalCalls, errorCount, avgDurationMs, p95DurationMs,
 *     byTool: { [name]: { calls, errors, avgMs, p95Ms, errorRate } },
 *     byToken: { [id]: { calls, errors } }
 *   }
 *
 * Auth: admin-authed. The response contains no secret values — just
 * aggregate counters. Still gated to prevent public reconnaissance of
 * which tools are hot (some tool names hint at the deployment's
 * intended use).
 */
async function getHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  const stats = getToolStats();
  // NIT-07: surface whether the underlying log store is ephemeral so a
  // monitoring poller can detect cold-start zeroing. `isEphemeral` is true
  // for any backend other than Upstash. `bufferSize` is the number of
  // in-memory ring-buffer entries currently feeding `byTool`/`byToken`.
  const store = getLogStore();
  const isEphemeral = store.kind !== "upstash";
  const bufferSize = getRecentLogs().length;

  return NextResponse.json({
    ...stats,
    isEphemeral,
    bufferSize,
    storeKind: store.kind,
  });
}

export const GET = withBootstrapRehydrate(getHandler);
