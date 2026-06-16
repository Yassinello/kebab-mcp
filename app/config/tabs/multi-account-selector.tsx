"use client";

/**
 * Phase 75 (MAUI-01..03) — multi-account selector for connectors backed by
 * the phase-73 store (Slack, Notion). One generic component parameterized
 * by connector + token-field list; the only per-connector difference is
 * the token inputs (Slack: bot + optional user token; Notion: one API key).
 *
 * Why this differs from UnipileAccountSelector:
 *   Unipile pins an account_id INSIDE one token to an env var. Slack/Notion
 *   hold N SEPARATE token SETS in tenant-scoped KV (cred:acct:*). So this
 *   component talks to /api/config/accounts (the phase-73 store routes),
 *   NOT /api/config/env. Each connected account is its own credential set.
 *
 * Flow:
 *   - On mount, GET the connected accounts for this connector.
 *   - List each account (name + a "default" badge on the pinned one) with a
 *     Remove button and a radio to pin the default (4s "Saved" flash).
 *   - "Add account" mini-form: token input(s) → POST. The route runs the
 *     connector's testConnection() first and rejects a bad token WITHOUT
 *     saving, so failures surface inline. On success the list refreshes and
 *     the form clears.
 *
 * Token values only ever travel one way (POST → server). The GET response
 * carries slug+name only — no credential ever comes back to the browser.
 */

import { useState, useEffect, useCallback } from "react";

interface AccountSummary {
  slug: string;
  name: string;
}

interface ListResponse {
  ok?: boolean;
  accounts?: AccountSummary[];
  default?: string;
  error?: string;
}

/** One token field rendered in the add-account form. */
export interface TokenField {
  key: string;
  label: string;
  placeholder: string;
  optional?: boolean;
}

const CONFIGS: Record<string, { label: string; fields: TokenField[] }> = {
  slack: {
    label: "Slack",
    fields: [
      { key: "SLACK_BOT_TOKEN", label: "Bot User OAuth Token", placeholder: "xoxb-…" },
      {
        key: "SLACK_USER_TOKEN",
        label: "User OAuth Token",
        placeholder: "xoxp-… (optional)",
        optional: true,
      },
    ],
  },
  notion: {
    label: "Notion",
    fields: [
      {
        key: "NOTION_API_KEY",
        label: "Internal Integration Token",
        placeholder: "secret_… or ntn_…",
      },
    ],
  },
};

export function MultiAccountSelector({
  connector,
  onAccountsChanged,
}: {
  connector: "slack" | "notion";
  /**
   * Phase 76: fired after a successful add/remove so the parent can
   * re-resolve the connector's gate state (the slack/notion gate now reads
   * account presence) — without this the card shows the new account but the
   * enable toggle stays disabled until a manual reload.
   */
  onAccountsChanged?: () => void;
}) {
  const cfg = CONFIGS[connector]!;
  const primaryKey = cfg.fields[0]!.key;

  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [defaultSlug, setDefaultSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Pinning + per-row state.
  const [savingDefault, setSavingDefault] = useState(false);
  const [savedDefault, setSavedDefault] = useState(false);
  const [removingSlug, setRemovingSlug] = useState<string | null>(null);
  // Add-account form.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/config/accounts?connector=${connector}`, {
        credentials: "include",
      });
      const data = (await res.json()) as ListResponse;
      if (!data.ok) {
        setError(data.error || "Could not load connected accounts.");
        setAccounts([]);
        return;
      }
      setAccounts(data.accounts ?? []);
      setDefaultSlug(data.default ?? null);
    } catch {
      setError("Network error while loading accounts.");
      setAccounts([]);
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [connector]);

  // Auto-load once on mount. The connector card only renders this when
  // enabled, so the list call almost always succeeds; failures fall back to
  // the Reload button + error box.
  useEffect(() => {
    // fire-and-forget OK: mount-time load; failures surface via the error box + Reload button.
    void loadAccounts();
  }, [loadAccounts]);

  async function pinDefault(slug: string) {
    setSavingDefault(true);
    setError(null);
    try {
      const res = await fetch("/api/config/accounts/default", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ connector, slug }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setError(data.error || "Failed to pin the default account.");
        return;
      }
      setDefaultSlug(slug);
      setSavedDefault(true);
      setTimeout(() => setSavedDefault(false), 4000);
    } catch {
      setError("Network error while pinning the default.");
    } finally {
      setSavingDefault(false);
    }
  }

  async function removeAccount(slug: string) {
    setRemovingSlug(slug);
    setError(null);
    try {
      const res = await fetch("/api/config/accounts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ connector, slug }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setError(data.error || "Failed to remove the account.");
        return;
      }
      await loadAccounts();
      onAccountsChanged?.();
    } catch {
      setError("Network error while removing the account.");
    } finally {
      setRemovingSlug(null);
    }
  }

  async function addAccount() {
    setAdding(true);
    setAddError(null);
    try {
      const tokens: Record<string, string> = {};
      for (const f of cfg.fields) {
        const v = (draft[f.key] ?? "").trim();
        if (v) tokens[f.key] = v;
      }
      const res = await fetch("/api/config/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ connector, tokens }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        // testConnection failed (or validation) — show inline, do NOT clear
        // the form so the operator can fix the token.
        setAddError(data.error || "Could not connect this account.");
        return;
      }
      setDraft({});
      await loadAccounts();
      onAccountsChanged?.();
    } catch {
      setAddError("Network error while adding the account.");
    } finally {
      setAdding(false);
    }
  }

  const canAdd = (draft[primaryKey] ?? "").trim().length > 0 && !adding;

  return (
    <div className="border-t border-border pt-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Connected accounts</p>
          <p className="text-xs text-text-dim mt-0.5">
            Connect more than one {cfg.label} workspace and pick which one tools act as by default.
            You can still override per call with the <code className="font-mono">account</code>{" "}
            parameter.
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

      {/* Connected accounts list — radio pins the default. */}
      {accounts.length > 0 && (
        <div className="space-y-1.5">
          {accounts.map((a) => {
            const isDefault = defaultSlug === a.slug;
            return (
              <div
                key={a.slug}
                className="flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-1.5"
              >
                <input
                  type="radio"
                  name={`default-${connector}`}
                  checked={isDefault}
                  disabled={savingDefault}
                  onChange={() => pinDefault(a.slug)}
                  className="accent-accent"
                  aria-label={`Pin ${a.name} as default`}
                />
                <span className="text-sm flex-1 truncate">{a.name}</span>
                {isDefault && (
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full text-green bg-green-bg">
                    {savedDefault ? "Saved" : "Default"}
                  </span>
                )}
                <button
                  onClick={() => removeAccount(a.slug)}
                  disabled={removingSlug === a.slug}
                  className="shrink-0 text-xs font-medium px-2 py-1 rounded-md text-red hover:bg-red-bg disabled:opacity-60"
                >
                  {removingSlug === a.slug ? "Removing…" : "Remove"}
                </button>
              </div>
            );
          })}
          {accounts.length === 1 && (
            <p className="text-[11px] text-text-muted">
              Only one account — tools use it automatically (no need to pin).
            </p>
          )}
        </div>
      )}

      {loadedOnce && accounts.length === 0 && !error && (
        <p className="text-xs text-text-muted italic">
          Connect your first {cfg.label} account below to activate this connector. We test the token
          before saving and name the account automatically.
        </p>
      )}

      {error && (
        <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red break-words">
          {error}
        </div>
      )}

      {/* Add-account mini-form. Phase 76: open by default when there are no
          accounts yet so the first-account step is the obvious next action on
          a freshly-expanded (and possibly disabled) card. */}
      <details className="group" open={loadedOnce && accounts.length === 0}>
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-text-muted hover:text-text select-none list-none flex items-center gap-1.5">
          <span className="inline-block transition-transform group-open:rotate-90">▶</span>
          {accounts.length === 0
            ? `Connect your first ${cfg.label} account`
            : `Add another ${cfg.label} account`}
        </summary>
        <div className="mt-3 space-y-3 rounded-md border border-border bg-bg-muted/40 px-4 py-3">
          <p className="text-[11px] text-text-dim leading-relaxed">
            {accounts.length === 0
              ? `Paste your ${cfg.label} credentials. We test the token before saving and name the account automatically from ${cfg.label}.`
              : `Paste the credentials for another ${cfg.label} account. We test the token before saving and name the account automatically from ${cfg.label}.`}
          </p>
          {cfg.fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] font-medium">{f.label}</label>
                {f.optional && (
                  <span className="text-[11px] text-text-muted bg-bg px-1.5 py-0.5 rounded">
                    optional
                  </span>
                )}
              </div>
              <input
                type="password"
                value={draft[f.key] ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                className="w-full text-sm font-mono rounded-md border border-border bg-bg px-3 py-1.5"
              />
            </div>
          ))}
          <div className="flex items-center gap-3">
            <button
              onClick={addAccount}
              disabled={!canAdd}
              className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {adding ? "Testing & saving…" : "Add account"}
            </button>
          </div>
          {addError && (
            <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red break-words">
              {addError}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
