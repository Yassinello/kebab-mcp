"use client";

/**
 * Phase 72 (D-72) — default-account picker for the Unipile connector.
 *
 * Why this exists:
 *   One Unipile token can be wired to several LinkedIn/WhatsApp accounts
 *   (e.g. a shared team Brevo token with 5 LinkedIn accounts). When ≥2
 *   accounts of a type exist the resolver refuses every call with
 *   error_account_id_required unless the operator pins which account is
 *   theirs. Account ids are opaque, so a free-text field is hostile — this
 *   dropdown calls the same /api/setup/test probe the "Test connection"
 *   button uses, reads back the {id, name, type} list, and lets the user
 *   pick by NAME. The choice is persisted to UNIPILE_<TYPE>_ACCOUNT_ID,
 *   which the resolver validates against the live list (D-72).
 *
 * UX (revised after user feedback): the dropdown is the ONLY primary path —
 * the raw account-id text fields were removed from the credential form.
 * On mount we auto-attempt to load the accounts (works when the token is
 * already saved), so the picker is populated without an extra click. A
 * collapsed "Enter an account id manually (advanced)" disclosure keeps a
 * text fallback for the rare case the probe can't reach Unipile, with a
 * helper explaining what an account id is.
 *
 * No credentials transit this component — it only ever sees the public
 * account id + display name returned by the probe.
 */

import { useState, useEffect, useCallback } from "react";

interface ProbeAccount {
  id: string;
  name: string;
  type: string;
}

interface TestResponse {
  ok?: boolean;
  message?: string;
  accounts?: ProbeAccount[];
}

const CHANNELS: Array<{ type: string; envKey: string; label: string }> = [
  { type: "LINKEDIN", envKey: "UNIPILE_LINKEDIN_ACCOUNT_ID", label: "LinkedIn" },
  { type: "WHATSAPP", envKey: "UNIPILE_WHATSAPP_ACCOUNT_ID", label: "WhatsApp" },
];

export function UnipileAccountSelector({
  values,
  onSaved,
}: {
  /** Current persisted env values, keyed by env var. Masked (••••) tolerated. */
  values: Record<string, string>;
  /** Called after a successful save so the parent can sync its env snapshot. */
  onSaved: (key: string, value: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [accounts, setAccounts] = useState<ProbeAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  // Advanced manual-entry drafts, keyed by env var.
  const [manual, setManual] = useState<Record<string, string>>({});

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Empty credentials → the test route fills them from the saved KV
      // snapshot (its documented fallback), so this works against an
      // already-saved connector without re-entering the token.
      const res = await fetch("/api/setup/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pack: "unipile", credentials: {} }),
      });
      const data = (await res.json()) as TestResponse;
      if (!data.ok) {
        setError(
          data.message || "Could not reach Unipile. Save your DSN + token above first, then retry."
        );
        setAccounts([]);
        return;
      }
      setAccounts(data.accounts ?? []);
    } catch {
      setError("Network error while loading accounts.");
      setAccounts([]);
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, []);

  // Auto-load once on mount. The connector is only rendered when enabled
  // (creds saved), so the probe almost always succeeds and the picker is
  // ready without the user hunting for a button. Failures fall back to the
  // manual "Reload" button + the advanced disclosure.
  useEffect(() => {
    // Mount-time probe; failures surface via the Reload button + error box.
    // fire-and-forget OK: effect has no cleanup to await against.
    void loadAccounts();
  }, [loadAccounts]);

  async function persist(envKey: string, value: string) {
    setSavingKey(envKey);
    setError(null);
    try {
      const res = await fetch("/api/config/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ vars: { [envKey]: value } }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setError(data.error || "Failed to save the default account.");
        return;
      }
      onSaved(envKey, value);
      setSavedKey(envKey);
      setTimeout(() => setSavedKey((k) => (k === envKey ? null : k)), 4000);
    } catch {
      setError("Network error while saving.");
    } finally {
      setSavingKey(null);
    }
  }

  const hasAnyAccounts = (accounts?.length ?? 0) > 0;

  return (
    <div className="border-t border-border pt-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Default account</p>
          <p className="text-xs text-text-dim mt-0.5">
            When one Unipile token has several LinkedIn or WhatsApp accounts, pick which one tools
            act as by default. You can still override per call.
          </p>
        </div>
        <button
          onClick={loadAccounts}
          disabled={loading}
          className="shrink-0 text-sm font-medium px-3 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text disabled:opacity-60"
        >
          {loading ? "Loading…" : loadedOnce ? "Reload" : "Load accounts"}
        </button>
      </div>

      {/* Per-channel dropdowns — the primary path. */}
      {hasAnyAccounts &&
        CHANNELS.map((ch) => {
          const forChannel = accounts!.filter((a) => a.type === ch.type);
          if (forChannel.length === 0) return null;
          const current = (values[ch.envKey] || "").replace(/•/g, "");
          // If the persisted value is masked (••••) we cannot match it to an
          // option; treat as "no selection" so the user can re-pick.
          const selected = forChannel.some((a) => a.id === current) ? current : "";
          return (
            <div key={ch.envKey} className="space-y-1">
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium">{ch.label}</label>
                {forChannel.length === 1 && (
                  <span className="text-[11px] text-text-muted">
                    (only one — auto-selected by the resolver)
                  </span>
                )}
                {savedKey === ch.envKey && (
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full text-green bg-green-bg">
                    Saved
                  </span>
                )}
              </div>
              <select
                value={selected}
                disabled={savingKey === ch.envKey}
                onChange={(e) => persist(ch.envKey, e.target.value)}
                className="w-full text-sm rounded-md border border-border bg-bg px-3 py-1.5 disabled:opacity-60"
              >
                <option value="">
                  {ch.type === "LINKEDIN"
                    ? "No default (refuse if ambiguous)"
                    : "No default (auto if only one)"}
                </option>
                {forChannel.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.id}
                  </option>
                ))}
              </select>
            </div>
          );
        })}

      {loadedOnce && !hasAnyAccounts && !error && (
        <p className="text-xs text-text-muted italic">
          No LinkedIn or WhatsApp accounts found on this token.
        </p>
      )}

      {error && (
        <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red break-words">
          {error}
        </div>
      )}

      {/* Advanced fallback: manual id entry, collapsed by default. */}
      <details className="group">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-text-muted hover:text-text select-none list-none flex items-center gap-1.5">
          <span className="inline-block transition-transform group-open:rotate-90">▶</span>
          Enter an account id manually (advanced)
        </summary>
        <div className="mt-3 space-y-3 rounded-md border border-border bg-bg-muted/40 px-4 py-3">
          <p className="text-[11px] text-text-dim leading-relaxed">
            Only needed if the dropdown can&apos;t load (e.g. Unipile unreachable). A Unipile
            account id is the opaque identifier shown in your{" "}
            <a
              href="https://dashboard.unipile.com/accounts"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2"
            >
              Unipile dashboard → Accounts
            </a>{" "}
            — a string like{" "}
            <code className="font-mono text-[11px] bg-bg px-1 rounded">aB3xY_p9Qk2…</code>, not your
            LinkedIn profile URL or email.
          </p>
          {CHANNELS.map((ch) => {
            const current = (values[ch.envKey] || "").replace(/•/g, "");
            const draft = manual[ch.envKey] ?? current;
            return (
              <div key={ch.envKey} className="space-y-1">
                <label className="text-[11px] font-medium">{ch.label} account id</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={draft}
                    placeholder="(leave empty for auto / safety net)"
                    onChange={(e) => setManual((m) => ({ ...m, [ch.envKey]: e.target.value }))}
                    className="flex-1 text-sm font-mono rounded-md border border-border bg-bg px-3 py-1.5"
                  />
                  <button
                    onClick={() => persist(ch.envKey, draft.trim())}
                    disabled={savingKey === ch.envKey}
                    className="shrink-0 text-sm font-medium px-3 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text disabled:opacity-60"
                  >
                    {savingKey === ch.envKey ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}
