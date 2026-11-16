"use client";

import { useState, useEffect } from "react";
import { UsageCard } from "./overview/usage-card";
import { HubSection } from "./overview/hub-card";
import type { ToolLog } from "@/core/logging";
import { ConnectorHealthWidget } from "./connector-health";
import { toMsg } from "@/core/error-utils";
import { formatRelativeTime } from "@/core/relative-time";

type RemoteUpdateMode = "github-api" | "release-sync";

type UpdateStatus =
  | { state: "loading" }
  | {
      state: "ready";
      mode: "git" | RemoteUpdateMode;
      available: boolean;
      // git mode fields
      behind?: number;
      ahead?: number;
      remote?: string;
      latest?: string | null;
      // github-api + release-sync fields
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
      reason?: string; // "auth" (token invalid/insufficient) | "unknown-version" (release-sync)
      message?: string;
      // release-sync fields (Kebab House phase 2, UPD-04)
      installedVersion?: string;
      latestVersion?: string;
      releaseUrl?: string;
      deployedRepo?: string;
    }
  | { state: "no-token"; configureUrl: string }
  | { state: "disabled"; reason: string }
  | { state: "error"; error: string };

type UpdateResult =
  | { state: "idle" }
  | { state: "pulling" }
  | { state: "done"; pulled: number; note?: string; deployUrl?: string }
  | { state: "deploying"; deployUrl: string; pulled: number; version?: string }
  | {
      state: "error";
      reason: string;
      message?: string;
      resolveUrl?: string;
      conflicts?: string[];
    };

const CONFIGURE_TOKEN_URL = "/config?tab=settings&sub=advanced";

/** Map a GET /api/config/update body to the banner state. */
function parseUpdateStatus(d: Record<string, unknown>): UpdateStatus {
  if (d.disabled) return { state: "disabled", reason: d.disabled as string };
  const remote = d.mode === "github-api" || d.mode === "release-sync";
  if (remote && d.reason === "no-token") {
    return { state: "no-token", configureUrl: (d.configureUrl as string) || CONFIGURE_TOKEN_URL };
  }
  if (remote) {
    const str = (k: string) => (typeof d[k] === "string" ? { [k]: d[k] as string } : {});
    return {
      state: "ready",
      mode: d.mode as RemoteUpdateMode,
      available: !!d.available,
      behind_by: (d.behind_by as number) || 0,
      ahead_by: (d.ahead_by as number) || 0,
      status: (d.status as "identical" | "behind" | "ahead" | "diverged") || "identical",
      breaking: !!d.breaking,
      breakingReasons: (d.breakingReasons as string[]) || [],
      commits: (d.commits as Array<{ sha: string; message: string; url: string }>) || [],
      totalCommits: (d.totalCommits as number) || 0,
      tokenConfigured: !!d.tokenConfigured,
      forkPrivate: !!d.forkPrivate,
      ...str("diffUrl"),
      ...str("checkedAt"),
      ...str("reason"),
      ...str("message"),
      ...str("installedVersion"),
      ...str("latestVersion"),
      ...str("releaseUrl"),
      ...str("deployedRepo"),
    };
  }
  const latest = d.latest as string | null | undefined;
  return {
    state: "ready",
    mode: "git",
    available: !!d.available,
    behind: (d.behind as number) || 0,
    ahead: (d.ahead as number) || 0,
    remote: (d.remote as string) || "",
    ...(latest !== undefined ? { latest } : {}),
  };
}

/** UPD-04: which update mechanism this deployment uses, in plain words. */
function updateModeLabel(update: UpdateStatus): string {
  switch (update.state) {
    case "loading":
      return "Checking…";
    case "no-token":
      return "Not set up — needs an update token";
    case "disabled":
      return "Disabled";
    case "error":
      return "Unknown (check failed)";
    case "ready":
      if (update.mode === "github-api") return "Fork sync (GitHub merge-upstream)";
      if (update.mode === "release-sync") return "Release sync (copies each upstream release)";
      return "Local git (fast-forward merge)";
  }
}

export function OverviewTab({
  baseUrl,
  totalTools,
  enabledCount,
  connectorCount,
  logs: initialLogs,
  version,
  commitSha,
  tenantId,
}: {
  baseUrl: string;
  totalTools: number;
  enabledCount: number;
  connectorCount: number;
  logs: ToolLog[];
  version: string;
  commitSha?: string | undefined;
  tenantId?: string | null | undefined;
}) {
  const [tokenRevealed, setTokenRevealed] = useState(false);
  // The server-rendered list comes from this page's own in-memory buffer,
  // which is not the one the MCP route writes to: read the same API as the
  // Logs page instead (audit 2026-11: Overview said "No tool invocations
  // yet" while Logs listed them).
  const [logs, setLogs] = useState<ToolLog[]>(initialLogs);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/config/logs", { credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as { logs?: ToolLog[] };
        if (!cancelled && Array.isArray(data.logs)) setLogs(data.logs);
      } catch {
        // keep the server-rendered list
      }
    };
    // fire-and-forget OK: client-side refresh; errors keep the server-rendered list
    void load();
    const id = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
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
      .then((d: Record<string, unknown>) => setUpdate(parseUpdateStatus(d)))
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
      setUpdate(parseUpdateStatus(d));
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
            ...(typeof data.version === "string" ? { version: data.version } : {}),
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
        // release-sync answers with `manualUrl`; the fork path with `resolveUrl`.
        const resolveUrl = (data.resolveUrl ?? data.manualUrl) as string | undefined;
        setResult({
          state: "error",
          reason,
          ...(typeof data.message === "string" ? { message: data.message } : {}),
          ...(resolveUrl !== undefined ? { resolveUrl } : {}),
          ...(Array.isArray(data.conflicts) ? { conflicts: data.conflicts as string[] } : {}),
        });
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

      {/* C1.1: the user's hub first — profile, skills, clients, notes. */}
      <HubSection />

      {/* Kebab House phase 0: weekly usage */}
      <UsageCard />

      {/* Server details, below the hub: health, counters, version, endpoint. */}
      <h2 className="text-sm font-semibold text-text-dim pt-4 border-t border-border">Server</h2>

      {/* Connector health — SLA sparklines */}
      <ConnectorHealthWidget />

      {/* Update banner — release-sync can't place the installed version */}
      {update.state === "ready" &&
        update.mode === "release-sync" &&
        update.reason === "unknown-version" && (
          <div className="border border-yellow-500/30 bg-yellow-500/5 rounded-lg p-4">
            <p className="text-sm font-semibold text-yellow-600 dark:text-yellow-400">
              Can&apos;t match this deployment to an upstream release
            </p>
            <p className="text-xs text-text-dim mt-0.5">{update.message}</p>
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
        update.mode !== "git" &&
        !update.reason &&
        update.status === "identical" && (
          <div className="border border-border bg-bg-muted/30 rounded-lg p-3 flex items-center gap-3">
            <span
              className={`text-xs flex-1 transition-colors ${justRefreshed ? "text-green" : "text-text-dim"}`}
            >
              {update.mode === "release-sync" && update.installedVersion
                ? `Up to date with Kebab House v${update.installedVersion}`
                : "Up to date with upstream"}
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
      {update.state === "ready" && update.mode !== "git" && update.reason === "auth" && (
        <div className="border border-red/30 bg-red/5 rounded-lg p-4">
          <p className="text-sm font-semibold text-red">GitHub authentication failed</p>
          <p className="text-xs text-text-dim mt-0.5">
            Your token may be invalid, revoked, or missing the required scope.
            {update.mode === "release-sync"
              ? ` Release sync writes commits to ${update.deployedRepo ?? "your repo"}: a fine-grained token needs Contents: read & write on it (classic: \`repo\`).`
              : update.forkPrivate
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
                    {update.mode === "release-sync"
                      ? `Kebab House v${update.latestVersion} available`
                      : update.mode === "github-api"
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
                  {update.mode === "release-sync"
                    ? `You run v${update.installedVersion} · ${update.behind_by} upstream ${(update.behind_by ?? 0) === 1 ? "commit" : "commits"} · Update now copies the release into ${update.deployedRepo ?? "your repo"}`
                    : update.mode === "github-api"
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
                {result.state === "error" && <UpdateError result={result} />}
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
            {result.version
              ? `Synced Kebab House v${result.version} — deploying...`
              : `Synced ${result.pulled} commit${result.pulled === 1 ? "" : "s"} — deploying...`}
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Active tools" value={totalTools} accent />
        <StatCard label="Active connectors" value={`${enabledCount} / ${connectorCount}`} />
        <StatCard
          label="Last tool call"
          value={lastLog ? new Date(lastLog.timestamp).toLocaleTimeString() : "—"}
          small
        />
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
        <Row label="Update mode" value={updateModeLabel(update)} />
        {update.state === "no-token" && (
          <p className="text-[11px] text-text-muted px-5 py-3">
            One-click updates need a GitHub token with <em>Contents: read &amp; write</em> on the
            repo this instance deploys from (<code className="font-mono">KEBAB_UPDATE_PAT</code>, or{" "}
            <code className="font-mono">GITHUB_TOKEN</code>).{" "}
            <a href={update.configureUrl} className="text-accent hover:underline">
              Add an update token
            </a>{" "}
            (optional). Forks can also use GitHub&apos;s <em>Sync fork</em> button.
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
      <Section title="Recent tool calls">
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

function UpdateError({ result }: { result: Extract<UpdateResult, { state: "error" }> }) {
  return (
    <div className="mt-1.5 space-y-1">
      <p className="text-xs text-red">{result.message ?? result.reason}</p>
      {result.conflicts && result.conflicts.length > 0 && (
        <ul className="text-[11px] font-mono text-text-dim list-disc pl-4">
          {result.conflicts.slice(0, 10).map((f) => (
            <li key={f}>{f}</li>
          ))}
          {result.conflicts.length > 10 && <li>…{result.conflicts.length - 10} more</li>}
        </ul>
      )}
      {result.resolveUrl && (
        <a
          href={result.resolveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent hover:underline inline-block"
        >
          See the changes on GitHub →
        </a>
      )}
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
