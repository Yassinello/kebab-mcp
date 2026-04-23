"use client";

/**
 * Phase 53 — KV quota gauge + warn banner.
 *
 * Shape matches /api/admin/metrics/kv-quota response. When source is
 * "unknown" (no Upstash creds), we surface an "unavailable" label
 * instead of a broken progress bar. Above 80% utilization a red
 * banner prepends the gauge.
 */

export interface KvQuotaData {
  usedBytes: number | null;
  usedHuman: string | null;
  limitBytes: number | null;
  percentage: number | null;
  source: "upstash" | "unknown";
}

export interface KvQuotaPanelProps {
  data: KvQuotaData | null;
}

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = n / 1024;
  if (kb >= 1) return `${kb.toFixed(1)} KB`;
  return `${n} B`;
}

export function KvQuotaPanel({ data }: KvQuotaPanelProps) {
  return (
    <div
      style={{
        background: "#111827",
        border: "1px solid #1f2937",
        borderRadius: "6px",
        padding: "12px 16px",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "8px" }}>KV quota</div>
      {!data || data.source === "unknown" ? (
        <div style={{ color: "#6b7280", fontSize: "14px" }}>
          KV provider: unknown — quota metrics unavailable (set UPSTASH_REDIS_REST_URL + token).
        </div>
      ) : (
        <>
          {data.percentage !== null && data.percentage > 80 && (
            <div
              data-testid="kv-quota-warn"
              style={{
                background: "#7f1d1d",
                color: "#fca5a5",
                padding: "6px 10px",
                borderRadius: "4px",
                fontSize: "13px",
                marginBottom: "8px",
              }}
            >
              KV usage above 80% — consider upgrading tier or purging old keys.
            </div>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              fontSize: "14px",
              marginBottom: "6px",
            }}
          >
            <span style={{ fontFamily: "ui-monospace, monospace" }}>
              {data.usedHuman ?? formatBytes(data.usedBytes)} / {formatBytes(data.limitBytes)}
            </span>
            <span style={{ color: "#9ca3af", fontSize: "12px" }}>
              {data.percentage !== null ? `${data.percentage.toFixed(1)}%` : "—"}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={data.percentage ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{
              width: "100%",
              height: "8px",
              background: "#1f2937",
              borderRadius: "4px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.max(0, Math.min(100, data.percentage ?? 0))}%`,
                height: "100%",
                background:
                  data.percentage !== null && data.percentage > 80
                    ? "#ef4444"
                    : data.percentage !== null && data.percentage > 50
                      ? "#f59e0b"
                      : "#10b981",
                transition: "width 500ms",
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
