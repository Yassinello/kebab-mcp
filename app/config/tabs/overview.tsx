"use client";

import { useState, useEffect } from "react";
import type { ToolLog } from "@/core/logging";
import type { InstanceConfig } from "@/core/types";

type UpdateStatus =
  | { state: "loading" }
  | { state: "ready"; available: boolean; behind: number; remote: string; latest?: string | null }
  | { state: "disabled"; reason: string }
  | { state: "error"; error: string };

type UpdateResult =
  | { state: "idle" }
  | { state: "pulling" }
  | { state: "done"; pulled: number; note?: string }
  | { state: "error"; reason: string };

export function OverviewTab({
  baseUrl,
  totalTools,
  enabledCount,
  packCount,
  logs,
  config,
}: {
  baseUrl: string;
  totalTools: number;
  enabledCount: number;
  packCount: number;
  logs: ToolLog[];
  config: InstanceConfig;
}) {
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus>({ state: "loading" });
  const [result, setResult] = useState<UpdateResult>({ state: "idle" });

  useEffect(() => {
    fetch("/api/config/update", { credentials: "include" })
      .then((r) => r.json())
      .then(
        (d: {
          available?: boolean;
          behind?: number;
          remote?: string;
          latest?: string;
          disabled?: string;
        }) => {
          if (d.disabled) {
            setUpdate({ state: "disabled", reason: d.disabled });
          } else {
            setUpdate({
              state: "ready",
              available: !!d.available,
              behind: d.behind || 0,
              remote: d.remote || "",
              latest: d.latest,
            });
          }
        }
      )
      .catch((err) =>
        setUpdate({ state: "error", error: err instanceof Error ? err.message : String(err) })
      );
  }, []);

  const pullUpdates = async () => {
    setResult({ state: "pulling" });
    try {
      const res = await fetch("/api/config/update", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setResult({ state: "done", pulled: data.pulled, note: data.note });
        setUpdate((s) => (s.state === "ready" ? { ...s, available: false, behind: 0 } : s));
      } else {
        setResult({ state: "error", reason: data.reason || "Update failed" });
      }
    } catch (err) {
      setResult({ state: "error", reason: err instanceof Error ? err.message : String(err) });
    }
  };

  const endpoint = `${baseUrl}/api/mcp`;
  const lastLog = logs[logs.length - 1];

  const copy = (label: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="space-y-6">
      {/* Update banner */}
      {update.state === "ready" && update.available && result.state !== "done" && (
        <div className="border border-orange/30 bg-orange/5 rounded-lg p-4 flex items-center gap-4">
          <div className="flex-1">
            <p className="text-sm font-semibold text-orange-dark">
              {update.behind} {update.behind === 1 ? "update" : "updates"} available
            </p>
            <p className="text-xs text-text-dim mt-0.5">
              New commits on {update.remote}/main
              {update.latest ? ` (latest: ${update.latest})` : ""} — fast-forward safe.
            </p>
            {result.state === "error" && (
              <p className="text-xs text-red mt-1.5 font-mono">{result.reason}</p>
            )}
          </div>
          <button
            onClick={pullUpdates}
            disabled={result.state === "pulling"}
            className="text-xs font-medium px-3 py-2 rounded-md bg-orange/10 text-orange-dark border border-orange/30 hover:bg-orange/20 transition-colors disabled:opacity-50"
          >
            {result.state === "pulling" ? "Updating..." : "Update now"}
          </button>
        </div>
      )}
      {result.state === "done" && result.pulled > 0 && (
        <div className="border border-green/30 bg-green/5 rounded-lg p-4">
          <p className="text-sm font-semibold text-green">
            Pulled {result.pulled} commit{result.pulled === 1 ? "" : "s"} ✓
          </p>
          <p className="text-xs text-text-dim mt-0.5">
            {result.note || "Restart the dev server to apply changes."}
          </p>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Active tools" value={totalTools} accent />
        <StatCard label="Active packs" value={`${enabledCount} / ${packCount}`} />
        <StatCard
          label="Last invocation"
          value={lastLog ? new Date(lastLog.timestamp).toLocaleTimeString() : "—"}
          small
        />
        <StatCard label="Display name" value={config.displayName} small />
      </div>

      {/* Endpoint */}
      <Section title="MCP endpoint">
        <Row
          label="URL"
          value={endpoint}
          action={
            <button
              onClick={() => copy("url", endpoint)}
              className="text-xs text-accent hover:underline"
            >
              {copied === "url" ? "Copied!" : "Copy"}
            </button>
          }
        />
        <Row
          label="Auth token"
          value={tokenRevealed ? "(see .env — MCP_AUTH_TOKEN)" : "••••••••••••"}
          action={
            <div className="flex gap-3">
              <button
                onClick={() => setTokenRevealed(!tokenRevealed)}
                className="text-xs text-accent hover:underline"
              >
                {tokenRevealed ? "Hide" : "Reveal"}
              </button>
            </div>
          }
        />
      </Section>

      {/* Recent activity */}
      <Section title="Recent activity">
        {logs.length === 0 ? (
          <p className="text-sm text-text-muted px-5 py-4">No tool invocations yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {logs
              .slice(-5)
              .reverse()
              .map((log, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${log.status === "success" ? "bg-green" : "bg-red"}`}
                  />
                  <span className="font-mono text-xs w-36 truncate">{log.tool}</span>
                  <span className="text-text-muted flex-1 truncate">
                    {log.status === "success" ? "OK" : log.error}
                  </span>
                  <span className="font-mono text-xs text-text-muted">{log.durationMs}ms</span>
                </div>
              ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
  small,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
  small?: boolean;
}) {
  return (
    <div className="border border-border rounded-lg p-4">
      <p
        className={`${small ? "text-sm" : "text-2xl"} font-bold font-mono ${accent ? "text-accent" : "text-text"}`}
      >
        {value}
      </p>
      <p className="text-[10px] text-text-muted uppercase tracking-wide mt-1">{label}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.1em] mb-3">
        {title}
      </h2>
      <div className="border border-border rounded-lg divide-y divide-border">{children}</div>
    </section>
  );
}

function Row({ label, value, action }: { label: string; value: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-5 py-3">
      <span className="text-xs text-text-muted w-24 shrink-0">{label}</span>
      <span className="font-mono text-xs text-text flex-1 truncate">{value}</span>
      {action}
    </div>
  );
}
