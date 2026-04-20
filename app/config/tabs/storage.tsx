"use client";

import { useState, useEffect, useCallback } from "react";

type StorageMode = "kv" | "file" | "static" | "kv-degraded";

interface StatusReport {
  mode: StorageMode;
  reason: string;
  dataDir: string | null;
  kvUrl: string | null;
  latencyMs: number | null;
  error: string | null;
  detectedAt: string;
  /** True for Vercel /tmp — saves vanish on cold start. */
  ephemeral?: boolean;
  counts: { credentials: number; skills: number; total: number } | null;
  legacy?: { backend: string; upstashConfigured: boolean; isVercel: boolean };
}

interface MigrationDiff {
  add: string[];
  update: string[];
  unchanged: string[];
}

/**
 * Effective presentation tuple = (mode, ephemeral?). We derive display meta
 * from the pair because Vercel `/tmp` file mode is a silent-data-loss trap
 * that looks like plain file mode to the detector but should NEVER be shown
 * as healthy in the UI. See storage-mode.ts for the underlying flag.
 */
function deriveMeta(
  mode: StorageMode,
  ephemeral: boolean
): { label: string; tone: "ok" | "warn" | "error" } {
  if (mode === "kv") return { label: "Upstash Redis", tone: "ok" };
  if (mode === "file" && ephemeral) {
    return { label: "Filesystem (temporary)", tone: "warn" };
  }
  if (mode === "file") return { label: "Filesystem", tone: "ok" };
  if (mode === "static") return { label: "Static (env-vars only)", tone: "warn" };
  return { label: "KV unreachable", tone: "error" };
}

export function StorageTab() {
  const [status, setStatus] = useState<StatusReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [rechecking, setRechecking] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);

  const load = useCallback(async (force = false) => {
    if (force) setRechecking(true);
    else setLoading(true);
    try {
      const res = await fetch(`/api/storage/status${force ? "?force=1" : ""}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as StatusReport;
      setStatus(data);
    } catch {
      // Silent — status card will fall back to "unknown"
    } finally {
      setLoading(false);
      setRechecking(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  if (loading) {
    return <p className="text-sm text-text-muted">Loading storage status…</p>;
  }

  if (!status) {
    return (
      <div className="border border-red/30 rounded-lg p-5 bg-red-bg/40">
        <h3 className="text-sm font-semibold text-red mb-1">Could not read storage status</h3>
        <p className="text-xs text-text-dim">
          Try refreshing the page. If the problem persists, check the server logs.
        </p>
      </div>
    );
  }

  const ephemeral = status.mode === "file" && Boolean(status.ephemeral);
  const meta = deriveMeta(status.mode, ephemeral);

  return (
    <div className="space-y-5">
      <WhatIsStorageExplainer />

      <ModeCard status={status} meta={meta} onRecheck={() => load(true)} rechecking={rechecking} />

      {status.mode === "kv" && (
        <KvHealthCard status={status} onMigrateFromFile={() => setMigrationOpen(true)} />
      )}

      {/* Ephemeral /tmp takes precedence over the normal file upgrade card —
          this is the silent-data-loss trap from the v2 review, and users on
          this mode need a prominent red/amber warning, not the gentle
          "Upgrade to KV (optional)" copy. */}
      {status.mode === "file" && ephemeral && <FileEphemeralWarningCard />}
      {status.mode === "file" && !ephemeral && <FileUpgradeCard />}

      {status.mode === "static" && <StaticUpgradeCard />}

      {status.mode === "kv-degraded" && (
        <KvDegradedCard status={status} onRecheck={() => load(true)} rechecking={rechecking} />
      )}

      {migrationOpen && (
        <MigrationModal
          direction="file-to-kv"
          onClose={() => setMigrationOpen(false)}
          onComplete={() => {
            setMigrationOpen(false);
            void load(true);
          }}
        />
      )}
    </div>
  );
}

/**
 * First-time orientation: what "storage" means in Kebab MCP terms, why the
 * user should care, and which backends are viable. Kept collapsible so it
 * doesn't clutter the page for users who already know the layout — but
 * open by default the first time the tab loads, since the subsequent
 * status cards assume the reader has this context.
 */
function WhatIsStorageExplainer() {
  return (
    <details className="border border-border rounded-lg bg-bg-muted/20 group" open>
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold flex items-center justify-between">
        <span>What is storage, and why does this page matter?</span>
        <span className="text-[11px] text-text-muted group-open:hidden">expand</span>
      </summary>
      <div className="border-t border-border px-4 py-4 space-y-3 text-xs text-text-dim leading-relaxed">
        <p>
          Kebab MCP persists three things: your{" "}
          <strong className="text-text">connector credentials</strong> (API keys for Google, Notion,
          Slack, etc.), your <strong className="text-text">skills</strong> (user-defined prompts),
          and your <strong className="text-text">context</strong> (the markdown file every AI
          request pre-loads). Storage is where those land when you save them from this dashboard.
        </p>
        <p>
          This page tells you which backend is currently active and whether it&apos;s healthy. If
          something goes wrong here, dashboard saves either vanish silently (ephemeral) or fail
          outright (KV unreachable) — both worth noticing immediately.
        </p>
        <ul className="space-y-1 list-disc list-inside">
          <li>
            <strong className="text-text">Upstash Redis</strong> — hosted key-value store.
            Recommended for Vercel. Free tier, saves survive cold starts, latency typically
            &lt;100ms.
          </li>
          <li>
            <strong className="text-text">Local filesystem</strong> — writes{" "}
            <code className="font-mono">./data/kv.json</code>. Good for Docker with a mounted volume
            or local dev. Per-instance, so not for horizontally-scaled deploys.
          </li>
          <li>
            <strong className="text-text">Env vars only</strong> — no runtime saves. Credentials are
            defined at deploy time in your hosting platform&apos;s env vars. Every change requires a
            redeploy.
          </li>
        </ul>
        <p className="text-[11px] text-text-muted">
          You can switch backends any time: set the env vars, redeploy, come back and click Recheck.
          File → KV migrations have a dedicated helper (see below).
        </p>
      </div>
    </details>
  );
}

function ModeCard({
  status,
  meta,
  onRecheck,
  rechecking,
}: {
  status: StatusReport;
  meta: { label: string; tone: "ok" | "warn" | "error" };
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const toneClass =
    meta.tone === "ok"
      ? "text-green bg-green-bg"
      : meta.tone === "warn"
        ? "text-orange bg-orange-bg"
        : "text-red bg-red-bg";
  const icon = meta.tone === "ok" ? "✓" : meta.tone === "warn" ? "⚠" : "✗";

  return (
    <div className="border border-border rounded-lg p-5 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold mb-1">Current storage mode</h3>
          <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${toneClass}`}>
            {icon} {meta.label}
          </span>
        </div>
        <button
          onClick={onRecheck}
          disabled={rechecking}
          className="text-xs font-medium px-3 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border disabled:opacity-60"
        >
          {rechecking ? "Rechecking…" : "Recheck"}
        </button>
      </div>

      <p className="text-xs text-text-dim leading-relaxed">{status.reason}</p>

      <div className="grid grid-cols-2 gap-3 pt-1">
        {status.kvUrl && <Field label="KV endpoint" value={status.kvUrl} mono />}
        {status.dataDir && <Field label="Data dir" value={status.dataDir} mono />}
        {status.latencyMs !== null && <Field label="KV latency" value={`${status.latencyMs}ms`} />}
        {status.counts && (
          <Field
            label="Stored keys"
            value={`${status.counts.credentials} cred · ${status.counts.skills} skill`}
          />
        )}
        <Field label="Detected" value={new Date(status.detectedAt).toLocaleString()} />
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-text-muted mb-0.5">{label}</p>
      <p className={`text-xs text-text ${mono ? "font-mono break-all" : ""}`}>{value}</p>
    </div>
  );
}

function KvHealthCard({
  status,
  onMigrateFromFile,
}: {
  status: StatusReport;
  onMigrateFromFile: () => void;
}) {
  return (
    <div className="border border-green/20 rounded-lg p-5 bg-green-bg/30 space-y-3">
      <h3 className="text-sm font-semibold">KV is healthy</h3>
      <p className="text-xs text-text-dim">
        Saves are instant and survive cold starts. No redeploy needed.
        {status.latencyMs !== null && status.latencyMs > 500 && (
          <>
            {" "}
            <span className="text-orange">
              Note: ping latency is {status.latencyMs}ms — usually under 200ms.
            </span>
          </>
        )}
      </p>
      {/* The "migrate from file" affordance lives here (not in FileUpgradeCard)
          because the migration endpoint requires KV to be reachable as the
          destination — running it from file mode is impossible by definition. */}
      <details className="pt-1">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-text-muted hover:text-text">
          Migrate from .env / file storage
        </summary>
        <div className="mt-2 text-xs text-text-dim space-y-2">
          <p>
            If you previously ran with file-based storage (Docker / dev) and have credentials in
            <code className="font-mono mx-1">./.env</code>, copy them into KV. Existing KV values
            are preserved unless overwritten by file values.
          </p>
          <button
            onClick={onMigrateFromFile}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border"
          >
            Preview & migrate
          </button>
        </div>
      </details>
    </div>
  );
}

function FileEphemeralWarningCard() {
  return (
    <div className="border border-orange/40 rounded-lg p-5 bg-orange-bg/40 space-y-3">
      <h3 className="text-sm font-semibold text-orange">
        ⚠ Your storage is temporary — set up Upstash now
      </h3>
      <p className="text-xs text-text-dim leading-relaxed">
        This instance is running on Vercel without Upstash configured. Saves go to{" "}
        <code className="font-mono">/tmp</code>, which{" "}
        <strong>Vercel recycles on every cold start</strong> (typically every 15–30 min of
        inactivity). Any connector credentials saved from the dashboard will look like they worked,
        then silently disappear.
      </p>
      <ol className="text-xs text-text-dim list-decimal list-inside space-y-0.5">
        <li>
          Open{" "}
          <a
            href="https://vercel.com/integrations/upstash"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2"
          >
            Vercel → Integrations → Upstash
          </a>{" "}
          (free tier is fine)
        </li>
        <li>Add the integration to this project — env vars auto-inject</li>
        <li>Vercel auto-redeploys, then click &ldquo;Recheck&rdquo; above</li>
      </ol>
      <p className="text-[11px] text-text-muted">
        Prefer not to use Upstash? You can run in env-vars-only mode by removing the writable{" "}
        <code className="font-mono">/tmp</code> path — but that requires setting every credential
        via Vercel env vars and redeploying for each change.
      </p>
    </div>
  );
}

function FileUpgradeCard() {
  return (
    <div className="border border-border rounded-lg p-5 space-y-3">
      <h3 className="text-sm font-semibold">Upgrade to KV (optional)</h3>
      <p className="text-xs text-text-dim leading-relaxed">
        File storage works great for single-instance Docker. If you need multi-instance sync, easy
        backups, or you&apos;re moving to a cloud platform, set up Upstash Redis. After it&apos;s
        connected and this instance is restarted, the &ldquo;Migrate from file&rdquo; option will
        appear here automatically.
      </p>
      <ol className="text-xs text-text-dim list-decimal list-inside space-y-0.5">
        <li>Set up Upstash and get a REST URL + token</li>
        <li>
          Add <code className="font-mono text-text">UPSTASH_REDIS_REST_URL</code> and{" "}
          <code className="font-mono text-text">UPSTASH_REDIS_REST_TOKEN</code>
        </li>
        <li>Restart this instance — mode flips to KV, migrate option becomes available</li>
      </ol>
      <a
        href="https://upstash.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs font-medium text-accent hover:text-accent/80 underline underline-offset-2"
      >
        Open Upstash
      </a>
    </div>
  );
}

function StaticUpgradeCard() {
  return (
    <div className="border border-orange/30 rounded-lg p-5 bg-orange-bg/30 space-y-3">
      <h3 className="text-sm font-semibold">Saves are disabled in static mode</h3>
      <p className="text-xs text-text-dim leading-relaxed">
        Your filesystem is read-only and no KV is configured. Connector credentials must be set as
        environment variables before deploy. To enable live saves from the dashboard, add Upstash
        Redis (free tier covers most personal use).
      </p>
      <ol className="text-xs text-text-dim list-decimal list-inside space-y-0.5">
        <li>
          Open{" "}
          <a
            href="https://vercel.com/integrations/upstash"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2"
          >
            Vercel → Integrations → Upstash
          </a>{" "}
          (or{" "}
          <a
            href="https://upstash.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2"
          >
            upstash.com
          </a>
          )
        </li>
        <li>Add the integration to this project — env vars auto-inject</li>
        <li>Redeploy, then click &ldquo;Recheck&rdquo; above</li>
      </ol>
    </div>
  );
}

function KvDegradedCard({
  status,
  onRecheck,
  rechecking,
}: {
  status: StatusReport;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  return (
    <div className="border border-red/30 rounded-lg p-5 bg-red-bg/30 space-y-3">
      <h3 className="text-sm font-semibold text-red">KV unreachable — saves blocked</h3>
      <p className="text-xs text-text-dim leading-relaxed">
        UPSTASH env vars are set but the endpoint isn&apos;t responding. To prevent data loss, we do{" "}
        <strong>not</strong> silently fall back to file storage. Check that your Upstash database is
        online and your token is valid.
      </p>
      {status.error && (
        <p className="text-[11px] font-mono text-red bg-bg p-2 rounded border border-red/20">
          {status.error}
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <a
          href="https://console.upstash.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-accent hover:text-accent/80 underline underline-offset-2"
        >
          Open Upstash console
        </a>
        <button
          onClick={onRecheck}
          disabled={rechecking}
          className="text-xs font-medium px-3 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border disabled:opacity-60"
        >
          {rechecking ? "Rechecking…" : "Retry detection"}
        </button>
      </div>
    </div>
  );
}

function MigrationModal({
  direction,
  onClose,
  onComplete,
}: {
  direction: "file-to-kv" | "kv-to-file";
  onClose: () => void;
  onComplete: () => void;
}) {
  const [phase, setPhase] = useState<"preview" | "confirming" | "running" | "done" | "error">(
    "preview"
  );
  const [diff, setDiff] = useState<MigrationDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [migrated, setMigrated] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/storage/migrate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ direction, dryRun: true }),
        });
        const data = (await res.json()) as { ok: boolean; diff?: MigrationDiff; error?: string };
        if (!data.ok || !data.diff) {
          setPhase("error");
          setError(data.error || "Preview failed");
          return;
        }
        setDiff(data.diff);
      } catch (err) {
        setPhase("error");
        setError(err instanceof Error ? err.message : "Network error");
      }
    })();
  }, [direction]);

  const confirm = async () => {
    setPhase("running");
    try {
      const res = await fetch("/api/storage/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ direction, dryRun: false }),
      });
      const data = (await res.json()) as { ok: boolean; migrated?: number; error?: string };
      if (!data.ok) {
        setPhase("error");
        setError(data.error || "Migration failed");
        return;
      }
      setMigrated(data.migrated ?? 0);
      setPhase("done");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Network error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-bg border border-border rounded-lg max-w-lg w-full p-6 space-y-4 shadow-xl">
        <h3 className="text-base font-semibold">
          Migrate {direction === "file-to-kv" ? "file → KV" : "KV → file"}
        </h3>

        {phase === "preview" && diff && (
          <>
            <div className="text-xs text-text-dim space-y-1">
              <p>
                <span className="text-green font-medium">+{diff.add.length}</span> new keys to add
              </p>
              <p>
                <span className="text-orange font-medium">~{diff.update.length}</span> existing keys
                to update
              </p>
              <p>
                <span className="text-text-muted">={diff.unchanged.length}</span> unchanged
                (skipped)
              </p>
            </div>
            {diff.add.length + diff.update.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-text-dim hover:text-text">
                  Show keys
                </summary>
                <ul className="mt-2 max-h-40 overflow-y-auto space-y-0.5 font-mono text-[11px]">
                  {diff.add.map((k) => (
                    <li key={k} className="text-green">
                      + {k}
                    </li>
                  ))}
                  {diff.update.map((k) => (
                    <li key={k} className="text-orange">
                      ~ {k}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="text-xs font-medium px-3 py-1.5 rounded-md text-text-dim hover:text-text"
              >
                Cancel
              </button>
              <button
                onClick={confirm}
                disabled={diff.add.length + diff.update.length === 0}
                className="text-xs font-medium px-4 py-1.5 rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
              >
                {diff.add.length + diff.update.length === 0
                  ? "Nothing to migrate"
                  : `Migrate ${diff.add.length + diff.update.length} key(s)`}
              </button>
            </div>
          </>
        )}

        {phase === "running" && <p className="text-xs text-text-dim">Migrating…</p>}

        {phase === "done" && (
          <>
            <p className="text-xs text-green">✓ Migrated {migrated} key(s) successfully.</p>
            <div className="flex justify-end pt-2">
              <button
                onClick={onComplete}
                className="text-xs font-medium px-4 py-1.5 rounded-md bg-accent text-white hover:bg-accent/90"
              >
                Done
              </button>
            </div>
          </>
        )}

        {phase === "error" && (
          <>
            <p className="text-xs text-red">{error}</p>
            <div className="flex justify-end pt-2">
              <button
                onClick={onClose}
                className="text-xs font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border"
              >
                Close
              </button>
            </div>
          </>
        )}

        {phase === "preview" && !diff && <p className="text-xs text-text-dim">Computing diff…</p>}
      </div>
    </div>
  );
}
