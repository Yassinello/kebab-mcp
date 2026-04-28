"use client";

import { useState, useEffect } from "react";
import type { ToolLog } from "@/core/logging";
import type { InstanceConfig } from "@/core/types";
import { ConnectorHealthWidget } from "./connector-health";
import { toMsg } from "@/core/error-utils";
import { formatRelativeTime } from "@/core/relative-time";

type UpdateStatus =
  | { state: "loading" }
  | {
      state: "ready";
      mode: "git" | "github-api";
      available: boolean;
      // git mode fields
      behind?: number;
      ahead?: number;
      remote?: string;
      latest?: string | null;
      // github-api mode fields
      behind_by?: number;
      ahead_by?: number;
      status?: "identical" | "behind" | "ahead" | "diverged";
      breaking?: boolean;
      breakingReasons?: string[];
      commits?: Array<{ sha: string; message: string; url: string }>;
      totalCommits?: number;
      diffUrl?: string;
      tokenConfigured?: boolean;
      forkPrivate?: boolean;
      checkedAt?: string; // CRON-03: ISO timestamp from KV cache or fresh fetch
      reason?: string; // optional: "auth" when PAT is invalid/insufficient scope
    }
  | { state: "no-token"; configureUrl: string }
  | {
      state: "not-a-fork";
      deployedRepo: string;
      upstreamRepo: string;
      redeployUrl: string;
    }
  | { state: "disabled"; reason: string }
  | { state: "error"; error: string };

type UpdateResult =
  | { state: "idle" }
  | { state: "pulling" }
  | { state: "done"; pulled: number; note?: string; deployUrl?: string }
  | { state: "deploying"; deployUrl: string; pulled: number }
  | { state: "error"; reason: string; resolveUrl?: string };

export function OverviewTab({
  baseUrl,
  totalTools,
  enabledCount,
  connectorCount,
  logs,
  config,
  version,
  commitSha,
  tenantId,
}: {
  baseUrl: string;
  totalTools: number;
  enabledCount: number;
  connectorCount: number;
  logs: ToolLog[];
  config: InstanceConfig;
  version: string;
  commitSha?: string | undefined;
  tenantId?: string | null | undefined;
}) {
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus>({ state: "loading" });
  const [result, setResult] = useState<UpdateResult>({ state: "idle" });
  // CRON-03: Refresh button state — debounce per D-13 (30s after click)
  const [refreshing, setRefreshing] = useState(false);
  const [refreshDisabledUntil, setRefreshDisabledUntil] = useState<number>(0);
  const [justRefreshed, setJustRefreshed] = useState(false);

  // Re-render when the debounce window expires so the disabled button
  // becomes clickable again without requiring an unrelated state change.
  useEffect(() => {
    if (refreshDisabledUntil > Date.now()) {
      const t = setTimeout(() => setRefreshDisabledUntil(0), refreshDisabledUntil - Date.now());
      return () => clearTimeout(t);
    }
    return undefined;
  }, [refreshDisabledUntil]);

  useEffect(() => {
    fetch("/api/config/update", { credentials: "include" })
      .then((r) => r.json())
      .then((d: Record<string, unknown>) => {
        if (d.disabled) {
          setUpdate({ state: "disabled", reason: d.disabled as string });
          return;
        }
        // github-api mode no-token
        if (d.mode === "github-api" && d.reason === "no-token") {
          setUpdate({
            state: "no-token",
            configureUrl: (d.configureUrl as string) || "/config?tab=settings&sub=advanced",
          });
          return;
        }
        // github-api mode standalone-clone (not a real fork of upstream)
        if (d.mode === "github-api" && d.reason === "not-a-fork") {
          setUpdate({
            state: "not-a-fork",
            deployedRepo: (d.deployedRepo as string) || "",
            upstreamRepo: (d.upstreamRepo as string) || "",
            redeployUrl: (d.redeployUrl as string) || "https://vercel.com/new",
          });
          return;
        }
        // github-api mode
        if (d.mode === "github-api") {
          const diffUrl = d.diffUrl as string | undefined;
          const reason = typeof d.reason === "string" ? d.reason : undefined;
          setUpdate({
            state: "ready",
            mode: "github-api",
            available: !!d.available,
            behind_by: (d.behind_by as number) || 0,
            ahead_by: (d.ahead_by as number) || 0,
            status: (d.status as "identical" | "behind" | "ahead" | "diverged") || "identical",
            breaking: !!d.breaking,
            breakingReasons: (d.breakingReasons as string[]) || [],
            commits: (d.commits as Array<{ sha: string; message: string; url: string }>) || [],
            totalCommits: (d.totalCommits as number) || 0,
            ...(diffUrl !== undefined ? { diffUrl } : {}),
            tokenConfigured: !!d.tokenConfigured,
            forkPrivate: !!d.forkPrivate,
            ...(typeof d.checkedAt === "string" ? { checkedAt: d.checkedAt } : {}),
            ...(reason !== undefined ? { reason } : {}),
          });
          return;
        }
        // git mode (existing shape)
        const latest = d.latest as string | null | undefined;
        setUpdate({
          state: "ready",
          mode: "git",
          available: !!d.available,
          behind: (d.behind as number) || 0,
          ahead: (d.ahead as number) || 0,
          remote: (d.remote as string) || "",
          ...(latest !== undefined ? { latest } : {}),
        });
      })
      .catch((err) => setUpdate({ state: "error", error: toMsg(err) }));
  }, []);

  // CRON-03: 30s debounce after click (D-13) — prevents GitHub API spam.
  const REFRESH_DEBOUNCE_MS = 30_000;

  const refreshUpdate = async () => {
    if (refreshing) return;
    if (Date.now() < refreshDisabledUntil) return;
    setRefreshing(true);
    setRefreshDisabledUntil(Date.now() + REFRESH_DEBOUNCE_MS);
    try {
      const res = await fetch("/api/config/update?force=1", { credentials: "include" });
      const d = (await res.json()) as Record<string, unknown>;
      if (d.disabled) {
        setUpdate({ state: "disabled", reason: d.disabled as string });
      } else if (d.mode === "github-api" && d.reason === "no-token") {
        setUpdate({
          state: "no-token",
          configureUrl: (d.configureUrl as string) || "/config?tab=settings&sub=advanced",
        });
      } else if (d.mode === "github-api" && d.reason === "not-a-fork") {
        setUpdate({
          state: "not-a-fork",
          deployedRepo: (d.deployedRepo as string) || "",
          upstreamRepo: (d.upstreamRepo as string) || "",
          redeployUrl: (d.redeployUrl as string) || "https://vercel.com/new",
        });
      } else if (d.mode === "github-api") {
        const diffUrl = d.diffUrl as string | undefined;
        const checkedAt = d.checkedAt as string | undefined;
        const reason = typeof d.reason === "string" ? d.reason : undefined;
        setUpdate({
          state: "ready",
          mode: "github-api",
          available: !!d.available,
          behind_by: (d.behind_by as number) || 0,
          ahead_by: (d.ahead_by as number) || 0,
          status: (d.status as "identical" | "behind" | "ahead" | "diverged") || "identical",
          breaking: !!d.breaking,
          breakingReasons: (d.breakingReasons as string[]) || [],
          commits: (d.commits as Array<{ sha: string; message: string; url: string }>) || [],
          totalCommits: (d.totalCommits as number) || 0,
          ...(diffUrl !== undefined ? { diffUrl } : {}),
          tokenConfigured: !!d.tokenConfigured,
          forkPrivate: !!d.forkPrivate,
          ...(checkedAt !== undefined ? { checkedAt } : {}),
          ...(reason !== undefined ? { reason } : {}),
        });
      }
      // Brief "just refreshed" flash so the user knows the click did something
      // even when nothing changed (D-13 follow-up — previously only animate-spin).
      setJustRefreshed(true);
      setTimeout(() => setJustRefreshed(false), 1500);
    } catch (err) {
      setUpdate({ state: "error", error: toMsg(err) });
    } finally {
      setRefreshing(false);
    }
  };

  const pullUpdates = async () => {
    setResult({ state: "pulling" });
    try {
      const res = await fetch("/api/config/update", {
        method: "POST",
        credentials: "include",
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (data.ok) {
        if (data.deployUrl) {
          // github-api mode: show deploying state
          setResult({
            state: "deploying",
            deployUrl: data.deployUrl as string,
            pulled: (data.pulled as number) || 0,
          });
        } else {
          const note = data.note as string | undefined;
          setResult({
            state: "done",
            pulled: (data.pulled as number) || 0,
            ...(note !== undefined ? { note } : {}),
          });
        }
        setUpdate((s) =>
          s.state === "ready" ? { ...s, available: false, behind: 0, behind_by: 0 } : s
        );
      } else {
        const reason = (data.reason as string) || "Update failed";
        const resolveUrl = data.resolveUrl as string | undefined;
        setResult({ state: "error", reason, ...(resolveUrl !== undefined ? { resolveUrl } : {}) });
      }
    } catch (err) {
      setResult({ state: "error", reason: toMsg(err) });
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
      {/* Tenant badge */}
      {tenantId && (
        <div className="flex items-center gap-2 border border-accent/30 bg-accent/5 rounded-lg px-4 py-2.5">
          <span className="text-xs font-semibold text-accent uppercase tracking-wide">Tenant:</span>
          <span className="font-mono text-sm text-text">{tenantId}</span>
        </div>
      )}

      {/* Connector health — SLA sparklines */}
      <ConnectorHealthWidget />

      {/* Update banner — standalone clone (not a fork of upstream) */}
      {update.state === "not-a-fork" && (
        <div className="border border-red/40 bg-red/5 rounded-lg p-4 flex items-start gap-4">
          <div className="flex-1">
            <p className="text-sm font-semibold text-red">
              This deployment can&apos;t receive updates
            </p>
            <p className="text-xs text-text-dim mt-1">
              Your deployment is connected to{" "}
              <code className="font-mono bg-bg-muted px-1 rounded">{update.deployedRepo}</code>,
              which is a standalone snapshot of{" "}
              <code className="font-mono bg-bg-muted px-1 rounded">{update.upstreamRepo}</code> —
              not a real GitHub fork. The dashboard&apos;s update flow uses GitHub&apos;s
              merge-upstream API, which only works on forks. As-is, you will never receive upstream
              fixes.
            </p>
            <p className="text-xs text-text-dim mt-2">
              <strong>Fix:</strong> redeploy from the upstream Deploy button (links direct to
              upstream, no copy). Your existing data in Upstash KV survives if you reattach the same
              integration.
            </p>
          </div>
          <a
            href={update.redeployUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-xs font-medium px-3 py-2 rounded-md bg-red/10 text-red border border-red/40 hover:bg-red/20 transition-colors"
          >
            Redeploy →
          </a>
        </div>
      )}

      {/* Update banner — diverged or ahead (block update) */}
      {update.state === "ready" &&
        update.mode === "github-api" &&
        (update.status === "diverged" || update.status === "ahead") && (
          <div className="border border-yellow-500/30 bg-yellow-500/5 rounded-lg p-4">
            <p className="text-sm font-semibold text-yellow-600 dark:text-yellow-400">
              Your fork has {update.ahead_by} local commit{(update.ahead_by ?? 0) !== 1 ? "s" : ""}{" "}
              ahead of upstream
            </p>
            <p className="text-xs text-text-dim mt-0.5">
              Automatic sync is disabled. Resolve divergence manually on GitHub.
            </p>
            {update.diffUrl && (
              <a
                href={update.diffUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent hover:underline mt-1.5 inline-block"
              >
                View diff on GitHub →
              </a>
            )}
          </div>
        )}

      {/* Update banner — up to date (with freshness indicator + refresh) — CRON-03 */}
      {update.state === "ready" &&
        update.mode === "github-api" &&
        update.status === "identical" && (
          <div className="border border-border bg-bg-muted/30 rounded-lg p-3 flex items-center gap-3">
            <span
              className={`text-xs flex-1 transition-colors ${justRefreshed ? "text-green" : "text-text-dim"}`}
            >
              Up to date with upstream
              {update.checkedAt && ` — checked ${formatRelativeTime(update.checkedAt)}`}
              {justRefreshed && " ✓"}
            </span>
            <RefreshIcon
              onClick={refreshUpdate}
              refreshing={refreshing}
              disabled={refreshing || Date.now() < refreshDisabledUntil}
            />
          </div>
        )}

      {/* Update banner — auth error (PAT invalid or insufficient scope) */}
      {update.state === "ready" && update.mode === "github-api" && update.reason === "auth" && (
        <div className="border border-red/30 bg-red/5 rounded-lg p-4">
          <p className="text-sm font-semibold text-red">GitHub authentication failed</p>
          <p className="text-xs text-text-dim mt-0.5">
            Your token may be invalid, revoked, or missing the required scope.
            {update.forkPrivate
              ? " Your fork is private — the PAT needs the `repo` scope (not just `public_repo`)."
              : " The PAT needs at least the `public_repo` scope."}
          </p>
          <a
            href="/config?tab=settings&sub=advanced"
            className="text-xs text-accent hover:underline mt-1.5 inline-block"
          >
            Reconfigure token →
          </a>
        </div>
      )}

      {/* Update banner — updates available */}
      {update.state === "ready" &&
        update.available &&
        result.state !== "done" &&
        result.state !== "deploying" && (
          <div className="border border-orange/30 bg-orange/5 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-orange-dark">
                    {update.mode === "github-api"
                      ? `${update.behind_by} ${(update.behind_by ?? 0) === 1 ? "update" : "updates"} available`
                      : `${update.behind} ${(update.behind ?? 0) === 1 ? "update" : "updates"} available`}
                  </p>
                  {update.breaking && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red/15 text-red uppercase tracking-wide">
                      Breaking
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-dim mt-0.5">
                  {update.mode === "github-api"
                    ? `New commits on upstream/main`
                    : `New commits on ${update.remote}/main${update.latest ? ` (latest: ${update.latest})` : ""}`}
                </p>
                {update.checkedAt && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <span
                      className={`text-[11px] transition-colors ${justRefreshed ? "text-green" : "text-text-muted"}`}
                    >
                      checked {formatRelativeTime(update.checkedAt)}
                      {justRefreshed && " ✓"}
                    </span>
                    <RefreshIcon
                      onClick={refreshUpdate}
                      refreshing={refreshing}
                      disabled={refreshing || Date.now() < refreshDisabledUntil}
                    />
                  </div>
                )}
                {result.state === "error" && (
                  <p className="text-xs text-red mt-1.5 font-mono">{result.reason}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {update.diffUrl && (
                  <a
                    href={update.diffUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium px-3 py-2 rounded-md bg-bg-muted text-text-dim border border-border hover:text-text transition-colors"
                  >
                    View diff
                  </a>
                )}
                <button
                  onClick={pullUpdates}
                  disabled={result.state === "pulling"}
                  className="text-xs font-medium px-3 py-2 rounded-md bg-orange/10 text-orange-dark border border-orange/30 hover:bg-orange/20 transition-colors disabled:opacity-50"
                >
                  {result.state === "pulling" ? "Updating..." : "Update now"}
                </button>
              </div>
            </div>

            {/* Commit list — up to 5 */}
            {update.commits && update.commits.length > 0 && (
              <div className="border border-border/50 rounded-md divide-y divide-border/30 text-xs">
                {update.commits.map((c) => (
                  <div key={c.sha} className="flex items-center gap-2 px-3 py-1.5">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-text-muted hover:text-accent shrink-0"
                    >
                      {c.sha}
                    </a>
                    <span className="text-text-dim truncate">{c.message}</span>
                  </div>
                ))}
                {(update.totalCommits ?? 0) > (update.commits?.length ?? 0) && (
                  <div className="px-3 py-1.5 text-text-muted">
                    …{(update.totalCommits ?? 0) - (update.commits?.length ?? 0)} more commits
                  </div>
                )}
              </div>
            )}

            {/* Breaking change details — only render with concrete reasons.
                The heuristic catches conventional-commit "feat!:" markers
                only; check the upstream release notes for the canonical list. */}
            {update.breaking && update.breakingReasons && update.breakingReasons.length > 0 && (
              <div className="border border-red/20 rounded-md p-2.5 bg-red/5">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-semibold text-red">
                    Possible breaking changes (heuristic)
                  </p>
                  <a
                    href="https://github.com/Yassinello/kebab-mcp/releases"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-accent hover:underline"
                  >
                    Release notes →
                  </a>
                </div>
                {update.breakingReasons.slice(0, 3).map((r, i) => (
                  <p key={i} className="text-xs font-mono text-text-dim truncate">
                    {r}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

      {/* Post-update: deploying state (github-api mode) */}
      {result.state === "deploying" && (
        <div className="border border-accent/30 bg-accent/5 rounded-lg p-4">
          <p className="text-sm font-semibold text-accent">
            Synced {result.pulled} commit{result.pulled === 1 ? "" : "s"} — deploying...
          </p>
          <p className="text-xs text-text-dim mt-0.5">
            Vercel is building the updated deployment. This takes ~2 minutes.
          </p>
          <a
            href={result.deployUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent hover:underline mt-1.5 inline-block"
          >
            View deployment status →
          </a>
        </div>
      )}

      {/* Post-update: done state (git mode) */}
      {result.state === "done" && result.pulled > 0 && (
        <div className="border border-green/30 bg-green/5 rounded-lg p-4">
          <p className="text-sm font-semibold text-green">
            Pulled {result.pulled} commit{result.pulled === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-text-dim mt-0.5">
            {result.note || "Restart the dev server to apply changes."}
          </p>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Active tools" value={totalTools} accent />
        <StatCard label="Active connectors" value={`${enabledCount} / ${connectorCount}`} />
        <StatCard
          label="Last invocation"
          value={lastLog ? new Date(lastLog.timestamp).toLocaleTimeString() : "—"}
          small
        />
        <StatCard label="Display name" value={config.displayName} small />
      </div>

      {/* Version info */}
      <Section title="Version">
        <Row
          label="Version"
          value={version}
          action={
            <button
              onClick={refreshUpdate}
              disabled={refreshing || Date.now() < refreshDisabledUntil}
              className="text-xs text-accent hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
              title="Force a fresh upstream check, bypassing the 48h cache"
            >
              {refreshing ? "Checking…" : justRefreshed ? "Checked ✓" : "Check for updates"}
            </button>
          }
        />
        {commitSha && <Row label="Commit" value={commitSha} />}
        {update.state === "no-token" && (
          <p className="text-[11px] text-text-muted px-3 pt-2">
            Updates land via GitHub&apos;s <em>Sync fork</em> button. For one-click sync from this
            dashboard,{" "}
            <a href={update.configureUrl} className="text-accent hover:underline">
              configure a GitHub PAT
            </a>{" "}
            (optional).
          </p>
        )}
      </Section>

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

function RefreshIcon({
  onClick,
  refreshing,
  disabled,
}: {
  onClick: () => void;
  refreshing: boolean;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Refresh update check"
      className="text-text-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      title={refreshing ? "Refreshing..." : "Refresh"}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={refreshing ? "animate-spin" : ""}
      >
        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
        <path d="M3 21v-5h5" />
      </svg>
    </button>
  );
}
