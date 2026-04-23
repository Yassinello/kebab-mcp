"use client";

/**
 * Phase 53 — Health tab metrics section.
 *
 * Composes the 5 chart panels + TenantSelector + RefreshControls under
 * a responsive grid. Each panel drives its own `useMetricsPoll` against
 * the corresponding /api/admin/metrics/* endpoint. When `tenantScope`
 * changes, all 5 URLs rebuild with the new `?tenant=` param and the
 * hook re-fetches.
 *
 * Scoped admins (rootScope=false) don't see the TenantSelector at all
 * — their metrics poll against the implicit current-tenant URL.
 */

import { useCallback, useMemo, useState } from "react";
import { RequestCountChart } from "./RequestCountChart";
import { LatencyBarChart } from "./LatencyBarChart";
import { ErrorHeatmap } from "./ErrorHeatmap";
import { RateLimitPanel, type RateLimitBucket } from "./RateLimitPanel";
import { KvQuotaPanel, type KvQuotaData } from "./KvQuotaPanel";
import { TenantSelector, ALL_TENANTS_SENTINEL } from "./TenantSelector";
import { RefreshControls } from "./RefreshControls";
import { useMetricsPoll, DEFAULT_REFRESH_SEC, resolveRefreshSec } from "./useMetricsPoll";

export interface MetricsSectionProps {
  rootScope: boolean;
  tenantIds: string[];
}

interface RequestsResponse {
  hours: Array<{ ts: number; count: number }>;
  source: "buffer" | "durable";
}

interface LatencyResponse {
  tools: Array<{ name: string; p95Ms: number; calls: number }>;
  source: "buffer" | "durable";
}

interface ErrorsResponse {
  connectors: Array<{
    connectorId: string;
    hours: Array<{ ts: number; errors: number; total: number }>;
  }>;
  source: "buffer" | "durable";
}

interface RateLimitResponse {
  buckets: RateLimitBucket[];
}

function buildUrl(path: string, tenantScope: string, tool?: string): string {
  const params = new URLSearchParams();
  if (tenantScope && tenantScope !== ALL_TENANTS_SENTINEL) params.set("tenant", tenantScope);
  else params.set("tenant", ALL_TENANTS_SENTINEL);
  if (tool) params.set("tool", tool);
  const qs = params.toString();
  return qs.length > 0 ? `${path}?${qs}` : path;
}

export function MetricsSection({ rootScope, tenantIds }: MetricsSectionProps) {
  const [tenantScope, setTenantScope] = useState<string>(ALL_TENANTS_SENTINEL);
  const [toolFilter, setToolFilter] = useState<string>("");

  // Effective refresh interval from ?refresh= URL param or DEFAULT.
  const refreshSec = useMemo(() => {
    if (typeof window === "undefined") return DEFAULT_REFRESH_SEC;
    return resolveRefreshSec(window.location.search);
  }, []);

  const requestsUrl = buildUrl("/api/admin/metrics/requests", tenantScope, toolFilter || undefined);
  const latencyUrl = buildUrl("/api/admin/metrics/latency", tenantScope);
  const errorsUrl = buildUrl("/api/admin/metrics/errors", tenantScope);
  const ratelimitUrl = "/api/admin/metrics/ratelimit"; // tenant is N/A (cross-tenant)
  const kvQuotaUrl = "/api/admin/metrics/kv-quota";

  const requests = useMetricsPoll<RequestsResponse>(requestsUrl);
  const latency = useMetricsPoll<LatencyResponse>(latencyUrl);
  const errors = useMetricsPoll<ErrorsResponse>(errorsUrl);
  const ratelimit = useMetricsPoll<RateLimitResponse>(ratelimitUrl);
  const kvQuota = useMetricsPoll<KvQuotaData>(kvQuotaUrl);

  const refreshAll = useCallback(() => {
    requests.refresh();
    latency.refresh();
    errors.refresh();
    ratelimit.refresh();
    kvQuota.refresh();
  }, [requests, latency, errors, ratelimit, kvQuota]);

  // Most-recent lastFetchedAt across all polls — surfaces the newest
  // success in the header timestamp.
  const lastFetchedAt = [
    requests.lastFetchedAt,
    latency.lastFetchedAt,
    errors.lastFetchedAt,
    ratelimit.lastFetchedAt,
    kvQuota.lastFetchedAt,
  ]
    .filter((d): d is Date => d !== null)
    .reduce<Date | null>((latest, d) => (!latest || d > latest ? d : latest), null);

  const effectiveSource =
    requests.data?.source === "durable" ||
    latency.data?.source === "durable" ||
    errors.data?.source === "durable"
      ? "durable"
      : kvQuota.data?.source === "unknown"
        ? "unknown"
        : "buffer";

  const toolOptions = useMemo(() => {
    // Derive from the latency response (which lists every tool with
    // calls) — keeps the filter in sync with reality rather than a
    // hard-coded registry snapshot.
    if (!latency.data) return [] as string[];
    return [...latency.data.tools].map((t) => t.name).sort((a, b) => a.localeCompare(b));
  }, [latency.data]);

  return (
    <div style={{ marginTop: "24px" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          marginBottom: "12px",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Usage &amp; health</h3>
        <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
          <TenantSelector
            tenantIds={tenantIds}
            value={tenantScope}
            onChange={setTenantScope}
            rootScope={rootScope}
          />
          <RefreshControls
            refreshSec={refreshSec}
            lastFetchedAt={lastFetchedAt}
            onRefresh={refreshAll}
            source={effectiveSource}
          />
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "12px",
        }}
      >
        <div style={{ gridColumn: "1 / -1" }}>
          <RequestCountChart
            hours={requests.data?.hours ?? []}
            tools={toolOptions}
            toolFilter={toolFilter}
            onToolChange={setToolFilter}
          />
        </div>
        <LatencyBarChart tools={latency.data?.tools ?? []} />
        <ErrorHeatmap connectors={errors.data?.connectors ?? []} />
        <RateLimitPanel buckets={ratelimit.data?.buckets ?? []} />
        <KvQuotaPanel data={kvQuota.data} />
      </div>
    </div>
  );
}
