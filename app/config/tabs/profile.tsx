"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/core/relative-time";
import { ProfilesField } from "./settings/profiles-field";
import { InfoTooltip } from "./settings/info-tooltip";
import { ProfileHistory } from "./profile-history";
import { YourDataSection } from "./your-data";
import { formatBytes } from "./overview/hub-state";
import { UnderlineTabs, TabPanel, useSubTab } from "../../components/page-tabs";

const PROFILE_VIEWS = ["profile", "profiles", "data"] as const;

type Mode = "inline" | "vault";

interface DefaultProfileState {
  mode: Mode;
  inline: string;
  vaultPath: string;
}

interface DefaultProfileInfo {
  bytes: number;
  updatedAt: string | null;
  by: string | null;
}

const SETUP_PHRASE = "Set up my Kebab House";

/**
 * 2026-11 audit (C1.2) — the Profile page: the default profile (inline
 * text, or a note in the memory vault) with one Save button, its history,
 * the other profiles ("hats") and the backup tools.
 *
 * Inline saves go through /api/config/profiles (they are recorded in the
 * profile history); choosing a vault note goes through /api/config/context.
 */
export function ProfileTab({
  vaultEnabled,
  initialPath,
}: {
  vaultEnabled: boolean;
  initialPath: string;
}) {
  const [state, setState] = useState<DefaultProfileState | null>(null);
  const [saved, setSaved] = useState<DefaultProfileState | null>(null);
  const [info, setInfo] = useState<DefaultProfileInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Redesign 2026-11: Your profile · Other profiles · Your data.
  const [view, setView] = useSubTab(PROFILE_VIEWS, "profile");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [ctxRes, infoRes] = await Promise.all([
          fetch("/api/config/context", { credentials: "include" }),
          fetch("/api/config/profiles?name=default", { credentials: "include" }),
        ]);
        if (!ctxRes.ok) throw new Error(String(ctxRes.status));
        const ctx = (await ctxRes.json()) as Partial<DefaultProfileState>;
        const meta = infoRes.ok
          ? ((await infoRes.json()) as Partial<DefaultProfileInfo> & { content?: string })
          : {};
        if (cancelled) return;
        const mode: Mode = ctx.mode === "vault" && vaultEnabled ? "vault" : "inline";
        const next: DefaultProfileState = {
          mode,
          inline: typeof ctx.inline === "string" ? ctx.inline : "",
          vaultPath:
            typeof ctx.vaultPath === "string" && ctx.vaultPath ? ctx.vaultPath : initialPath,
        };
        setState(next);
        setSaved(next);
        setInfo({
          bytes: typeof meta.bytes === "number" ? meta.bytes : 0,
          updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : null,
          by: typeof meta.by === "string" ? meta.by : null,
        });
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultEnabled, initialPath, reloadKey]);

  const dirty =
    !!state &&
    !!saved &&
    (state.mode !== saved.mode ||
      (state.mode === "inline"
        ? state.inline !== saved.inline
        : state.vaultPath !== saved.vaultPath));

  const save = async () => {
    if (!state) return;
    setSaving(true);
    setError(null);
    try {
      const res =
        state.mode === "inline"
          ? await fetch("/api/config/profiles", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ name: "default", content: state.inline }),
            })
          : await fetch("/api/config/context", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ mode: "vault", inline: "", vaultPath: state.vaultPath }),
            });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || data.ok === false) {
        setError(data.message || data.error || "Save failed");
      } else {
        setFlash("Saved");
        setTimeout(() => setFlash(null), 2500);
        setReloadKey((k) => k + 1);
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <p className="text-sm text-text-dim">
        Could not load your profile. Reload the page to try again.
      </p>
    );
  }
  if (!state || !info) return <p className="text-sm text-text-muted">Loading…</p>;

  const empty = state.mode === "inline" && saved?.inline.trim() === "";

  return (
    <div>
      <UnderlineTabs
        label="Profile sections"
        idBase="profile"
        value={view}
        onChange={setView}
        tabs={[
          { id: "profile", label: "Your profile" },
          { id: "profiles", label: "Other profiles" },
          { id: "data", label: "Your data" },
        ]}
      />
      <TabPanel idBase="profile" value={view}>
        <div className="max-w-3xl">
          {view === "profile" && (
            <section className="space-y-4" aria-labelledby="pf-title">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 id="pf-title" className="text-base font-semibold">
                      Your profile
                    </h2>
                    <InfoTooltip
                      title="What is your profile?"
                      body="A short text about you: your role, current projects, how you like answers. Every connected AI client reads it at the start of a conversation, so you don't have to explain yourself again."
                    />
                  </div>
                  <p className="text-sm text-text-dim mt-1" data-testid="profile-status">
                    {saved?.mode === "vault"
                      ? `Lives in your notes: ${saved.vaultPath}`
                      : empty
                        ? "Empty"
                        : [
                            formatBytes(info.bytes),
                            info.updatedAt
                              ? `updated ${formatRelativeTime(info.updatedAt)}${info.by ? ` by ${info.by}` : ""}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                  </p>
                </div>
                <div
                  className="inline-flex border border-border rounded-md overflow-hidden text-xs"
                  role="group"
                  aria-label="Where your profile lives"
                >
                  <button
                    type="button"
                    aria-pressed={state.mode === "inline"}
                    onClick={() => setState({ ...state, mode: "inline" })}
                    className={`px-3 py-1.5 ${
                      state.mode === "inline"
                        ? "bg-accent text-white"
                        : "bg-bg-muted text-text-dim hover:text-text"
                    }`}
                  >
                    Write it here
                  </button>
                  <button
                    type="button"
                    aria-pressed={state.mode === "vault"}
                    disabled={!vaultEnabled}
                    onClick={() => vaultEnabled && setState({ ...state, mode: "vault" })}
                    title={
                      vaultEnabled
                        ? "Use a note from your memory as your profile"
                        : "Turn on the Memory Vault connector to use a note"
                    }
                    className={`px-3 py-1.5 ${
                      state.mode === "vault"
                        ? "bg-accent text-white"
                        : "bg-bg-muted text-text-dim hover:text-text"
                    } ${!vaultEnabled ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    Use a note
                  </button>
                </div>
              </div>

              {empty && (
                <div className="border border-accent/30 bg-accent/5 rounded-md p-3 text-sm">
                  <p className="font-medium text-text">Your profile is empty.</p>
                  <p className="text-text-dim mt-1">
                    The easiest way to fill it: in any connected AI client, say{" "}
                    <strong className="text-text">“{SETUP_PHRASE}”</strong>. It asks you a few
                    questions and saves the answers here. You can also write it yourself below.
                  </p>
                </div>
              )}

              {state.mode === "inline" ? (
                <textarea
                  value={state.inline}
                  onChange={(e) => setState({ ...state, inline: e.target.value })}
                  rows={14}
                  aria-label="Profile text"
                  placeholder={"# About me\n\nYour role, current projects, how you like answers."}
                  className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
              ) : (
                <div className="space-y-1.5">
                  <label htmlFor="profile-vault-path" className="text-sm font-medium block">
                    Note to use as your profile
                  </label>
                  <input
                    id="profile-vault-path"
                    type="text"
                    value={state.vaultPath}
                    onChange={(e) => setState({ ...state, vaultPath: e.target.value })}
                    placeholder="System/context.md"
                    className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                  />
                  <p className="text-xs text-text-muted">
                    Path of the note in your memory, for example{" "}
                    <code className="font-mono">System/context.md</code>. Its own changes are kept
                    by your notes storage.
                  </p>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || !dirty}
                  className="bg-accent text-white text-sm font-medium px-5 py-2 rounded-md hover:bg-accent/90 disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                {flash && (
                  <span className="text-xs text-green" role="status">
                    {flash}
                  </span>
                )}
                {error && <span className="text-xs text-red">{error}</span>}
              </div>

              {saved?.mode === "inline" && (
                <div className="border-t border-border pt-6 mt-2">
                  <ProfileHistory
                    name="default"
                    refreshKey={reloadKey}
                    onRestored={() => setReloadKey((k) => k + 1)}
                  />
                </div>
              )}
            </section>
          )}

          {view === "profiles" && (
            <section aria-labelledby="hats-title">
              <div className="flex items-center gap-2 mb-1">
                <h2 id="hats-title" className="text-base font-semibold">
                  Other profiles (one per hat)
                </h2>
                <InfoTooltip
                  title="Profiles per hat"
                  body="Give each AI client its own profile (Devices → Edit scope). For example a 'perso' profile for your personal assistant and a 'work' profile for your work account."
                />
              </div>
              <p className="text-sm text-text-dim mb-4">
                Optional. An AI client bound to one of these reads it instead of your main profile.
              </p>
              <ProfilesField />
            </section>
          )}

          {view === "data" && <YourDataSection onImported={() => setReloadKey((k) => k + 1)} />}
        </div>
      </TabPanel>
    </div>
  );
}
