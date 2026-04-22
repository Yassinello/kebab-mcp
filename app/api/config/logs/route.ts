import { NextResponse } from "next/server";
import { getRecentLogs, getDurableLogs } from "@/core/logging";
import { getLogStore } from "@/core/log-store";
import { getTenantId, TenantError } from "@/core/tenant";
import { withAdminAuth } from "@/core/with-admin-auth";
import { getLogger } from "@/core/logging";
import type { PipelineContext } from "@/core/pipeline";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";

const logsRouteLog = getLogger("API:config/logs");

/**
 * GET /api/config/logs?count=100&filter=all|errors|success&scope=all&tenant=<id>
 *
 * Returns recent tool logs. When `MYMCP_DURABLE_LOGS=true` the payload
 * is sourced from the pluggable LogStore (O1) — Upstash list in prod,
 * filesystem JSONL in dev, in-memory fallback on Vercel without
 * Upstash. Otherwise falls back to the in-process ring buffer.
 *
 * **Phase 42 (TEN-02) — tenant-scoped durable logs:**
 * `getLogStore()` returns a per-tenant instance; Upstash reads
 * land on `tenant:<id>:mymcp:logs`. Namespace isolation at the
 * storage layer — no application-code filter.
 *
 * **Phase 48 (ISO-01 / ISO-02) — tenant-scoped in-memory buffer:**
 * The pre-Phase-48 ring buffer was a single operator-wide array; the
 * route compensated with a `tokenId` application-code filter. That
 * filter is REMOVED — the buffer is now `Map<tenantId, ToolLog[]>`
 * (see src/core/logging.ts). Query semantics:
 *   - Default: reads the caller's tenant bucket via
 *     getRecentLogs(n, {tenantId}) — privacy by default.
 *   - `?scope=all` under a ROOT admin (no tenant header) returns the
 *     union across all tenants. Silently downgraded for tenant-scoped
 *     callers (privacy guard).
 *   - `?tenant=<id>` under a ROOT admin: explicit bucket select.
 *
 * TECH-07: unified with mcp-logs tool — both now call the same
 * `getDurableLogs()` helper which reads from `getLogStore().recent()`
 * and handles the meta → ToolLog unwrap + filtering.
 *
 * Admin-auth-gated.
 */
async function getHandler(ctx: PipelineContext) {
  const request = ctx.request;

  // Validate the x-mymcp-tenant header (400 on malformed). Value is
  // used for the in-memory ring buffer; the durable branch relies on
  // namespace isolation via getLogStore() → per-tenant.
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

  // ISO-02: scope/tenant query args. Privacy guard — a tenant-scoped
  // caller cannot elevate to scope=all or inspect another tenant's
  // bucket via ?tenant=<id>.
  const scopeQuery = url.searchParams.get("scope");
  const tenantQuery = url.searchParams.get("tenant");
  const isRootCaller = tenantId === null;
  const scope: "all" | undefined = scopeQuery === "all" && isRootCaller ? "all" : undefined;
  const explicitTenant = isRootCaller && tenantQuery ? tenantQuery : null;

  if (getConfig("MYMCP_DURABLE_LOGS") === "true") {
    try {
      const store = getLogStore();
      // Phase 42 / TEN-02: getDurableLogs() reads via getLogStore().recent(),
      // which is now tenant-scoped. No application-code tokenId filter.
      const logs = await getDurableLogs(n, filter);
      return NextResponse.json({ ok: true, logs, source: store.kind });
    } catch (err) {
      // Fall through to the in-memory ring buffer so the dashboard
      // never loses visibility if the store is momentarily unhealthy.
      logsRouteLog.error("log store read failed, falling back to memory", {
        error: toMsg(err),
      });
    }
  }

  // Phase 48 / ISO-02: in-memory branch reads from the per-tenant
  // ring buffer directly — no application-code tokenId filter needed.
  let logs = scope
    ? getRecentLogs(n, { scope: "all" })
    : getRecentLogs(n, { tenantId: explicitTenant ?? tenantId });
  if (filter === "errors") {
    logs = logs.filter((l) => l.status === "error");
  } else if (filter === "success") {
    logs = logs.filter((l) => l.status === "success");
  }
  return NextResponse.json({ ok: true, logs, source: "memory" });
}

export const GET = withAdminAuth(getHandler);
