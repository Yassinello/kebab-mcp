import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { getRecentLogs, type ToolLog } from "@/core/logging";
import { getLogStore } from "@/core/log-store";

/**
 * GET /api/config/logs?count=100
 *
 * Returns recent tool logs. When `MYMCP_DURABLE_LOGS=true` the payload
 * is sourced from the pluggable LogStore (O1) — Upstash list in prod,
 * filesystem JSONL in dev, in-memory fallback on Vercel without
 * Upstash. Otherwise falls back to the in-process ring buffer.
 *
 * Admin-auth-gated.
 */
export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const count = parseInt(url.searchParams.get("count") || "100", 10);
  const n = Number.isFinite(count) ? count : 100;

  if (process.env.MYMCP_DURABLE_LOGS === "true") {
    try {
      const store = getLogStore();
      const entries = await store.recent(n);
      // Unwrap meta (which holds the original ToolLog shape) so the
      // dashboard keeps rendering with the same field names.
      const logs: ToolLog[] = entries
        .map((e) => e.meta as unknown as ToolLog)
        .filter((l): l is ToolLog => !!l && typeof l.tool === "string");
      return NextResponse.json({ ok: true, logs, source: store.kind });
    } catch (err) {
      // Fall through to the in-memory ring buffer so the dashboard
      // never loses visibility if the store is momentarily unhealthy.
      console.error(
        "[MyMCP] /api/config/logs: log store read failed, falling back to memory:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  const logs = getRecentLogs(n);
  return NextResponse.json({ ok: true, logs, source: "memory" });
}
