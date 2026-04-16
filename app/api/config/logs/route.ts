import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { getRecentLogs, getDurableLogs } from "@/core/logging";
import { getLogStore } from "@/core/log-store";
import { getTenantId, TenantError } from "@/core/tenant";

/**
 * GET /api/config/logs?count=100&filter=all|errors|success
 *
 * Returns recent tool logs. When `MYMCP_DURABLE_LOGS=true` the payload
 * is sourced from the pluggable LogStore (O1) — Upstash list in prod,
 * filesystem JSONL in dev, in-memory fallback on Vercel without
 * Upstash. Otherwise falls back to the in-process ring buffer.
 *
 * TECH-07: unified with mcp-logs tool — both now call the same
 * `getDurableLogs()` helper which reads from `getLogStore().recent()`
 * and handles the meta → ToolLog unwrap + filtering.
 *
 * Admin-auth-gated.
 */
export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  // Tenant scoping: if x-mymcp-tenant header is present, filter logs
  // by tokenId prefix (tenant tokens are namespaced). When absent, show all.
  let tenantId: string | null = null;
  try {
    tenantId = getTenantId(request);
  } catch (err) {
    if (err instanceof TenantError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
  }

  const url = new URL(request.url);
  const count = parseInt(url.searchParams.get("count") || "100", 10);
  const n = Number.isFinite(count) ? count : 100;
  const filter = (url.searchParams.get("filter") as "all" | "errors" | "success") || "all";

  if (process.env.MYMCP_DURABLE_LOGS === "true") {
    try {
      const store = getLogStore();
      const logs = await getDurableLogs(n, filter);
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

  let logs = getRecentLogs(n);
  if (filter === "errors") {
    logs = logs.filter((l) => l.status === "error");
  } else if (filter === "success") {
    logs = logs.filter((l) => l.status === "success");
  }
  // Scope logs by tenant: filter to logs whose tokenId matches the tenant
  if (tenantId) {
    logs = logs.filter((l) => l.tokenId === tenantId);
  }
  return NextResponse.json({ ok: true, logs, source: "memory" });
}
