"use client";

import { useCallback, useEffect, useState } from "react";

interface ProfileSummary {
  name: string;
  mode: "inline" | "vault";
  bytes: number;
  updatedAt: string | null;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Kebab House phase 0 (CTX-06) — named profiles, one per "hat".
 *
 * The default profile is edited by <ContextFileField> just above; this
 * component manages the extra profiles a token can be bound to (Devices →
 * Edit scope → Profile).
 */
export function ProfilesField() {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ name: string; content: string; isNew: boolean } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/config/profiles", { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as { profiles?: ProfileSummary[] };
        setProfiles((data.profiles ?? []).filter((p) => p.name !== "default"));
      }
    } catch {
      // Network error: keep the current list; the editor stays usable.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // fire-and-forget OK: initial list load; errors leave the list empty
    void load();
  }, [load]);

  const openExisting = async (name: string) => {
    setError(null);
    const res = await fetch(`/api/config/profiles?name=${encodeURIComponent(name)}`, {
      credentials: "include",
    });
    if (!res.ok) return setError("Could not load this profile");
    const data = (await res.json()) as { content: string };
    setEditing({ name, content: data.content, isNew: false });
  };

  const save = async () => {
    if (!editing) return;
    const name = editing.name.trim().toLowerCase();
    if (!NAME_RE.test(name) || name === "default") {
      return setError("Use lowercase letters, digits and dashes (not 'default').");
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/config/profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name, content: editing.content }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      return setError(data.message || "Save failed");
    }
    setEditing(null);
    await load();
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Delete the profile "${name}"? Tokens bound to it fall back to default.`))
      return;
    setBusy(true);
    await fetch(`/api/config/profiles?name=${encodeURIComponent(name)}`, {
      method: "DELETE",
      credentials: "include",
    });
    setBusy(false);
    await load();
  };

  if (loading) return <div className="text-xs text-text-muted">Loading…</div>;

  return (
    <div className="space-y-2">
      {profiles.length === 0 && !editing && (
        <p className="text-xs text-text-muted">
          No extra profile yet. Add one per hat (e.g. <code className="font-mono">perso</code>,{" "}
          <code className="font-mono">work</code>) and bind it to a client token in Devices.
        </p>
      )}
      {profiles.length > 0 && (
        <ul className="divide-y divide-border border border-border rounded-md">
          {profiles.map((p) => (
            <li key={p.name} className="flex items-center justify-between px-3 py-2 text-xs">
              <span className="font-mono">{p.name}</span>
              <span className="flex items-center gap-3">
                <span className="text-text-muted">{(p.bytes / 1024).toFixed(1)} KB</span>
                <button
                  type="button"
                  onClick={() => void openExisting(p.name)}
                  className="underline hover:text-text"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(p.name)}
                  className="text-red-500 underline disabled:opacity-50"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <div className="space-y-2 border border-border rounded-md p-3">
          <input
            type="text"
            value={editing.name}
            disabled={!editing.isNew}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder="profile name, e.g. work"
            aria-label="Profile name"
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-1.5 text-sm font-mono disabled:opacity-60"
          />
          <textarea
            value={editing.content}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            rows={8}
            aria-label="Profile content"
            placeholder="# About me (this hat)&#10;&#10;Role, current projects, preferences for this context."
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              className="bg-bg border border-border hover:bg-bg-muted text-xs font-medium px-3 py-1.5 rounded-md disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save profile"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setError(null);
              }}
              className="text-xs underline"
            >
              Cancel
            </button>
            {error && <span className="text-xs text-red-500">{error}</span>}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing({ name: "", content: "", isNew: true })}
          className="bg-bg border border-border hover:bg-bg-muted text-xs font-medium px-3 py-1.5 rounded-md"
        >
          Add a profile
        </button>
      )}
    </div>
  );
}
