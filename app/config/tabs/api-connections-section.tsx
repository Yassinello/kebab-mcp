"use client";

import { useState, useEffect, useCallback } from "react";
import { OutlineIcon } from "../../components/outline-icon";

type AuthType = "none" | "bearer" | "api_key_header" | "basic";

interface AuthNone {
  type: "none";
}
interface AuthBearer {
  type: "bearer";
  token: string;
}
interface AuthApiKey {
  type: "api_key_header";
  headerName: string;
  value: string;
}
interface AuthBasic {
  type: "basic";
  username: string;
  password: string;
}
type Auth = AuthNone | AuthBearer | AuthApiKey | AuthBasic;

interface ApiConnection {
  id: string;
  name: string;
  baseUrl: string;
  auth: Auth;
  headers: Record<string, string>;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

interface Draft {
  editingId: string | null;
  name: string;
  baseUrl: string;
  auth: Auth;
  headersText: string; // one "Key: Value" per line
  timeoutMs: number;
}

const emptyDraft = (): Draft => ({
  editingId: null,
  name: "",
  baseUrl: "",
  auth: { type: "none" },
  headersText: "",
  timeoutMs: 30000,
});

function parseHeadersText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    out[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
  }
  return out;
}

function headersToText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export function ApiConnectionsSection() {
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; status?: number; ms: number; error?: string }>
  >({});
  const [flash, setFlash] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/config/api-connections", { credentials: "include" });
      const data = await res.json();
      if (data.ok) setConnections(data.connections || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const startCreate = () => {
    setDraft(emptyDraft());
    setError(null);
  };

  const startEdit = (c: ApiConnection) => {
    setDraft({
      editingId: c.id,
      name: c.name,
      baseUrl: c.baseUrl,
      // auth coming back is redacted (***) — the user re-enters if they
      // want to rotate it. Keep auth.type to render the right fields.
      auth: c.auth,
      headersText: headersToText(c.headers || {}),
      timeoutMs: c.timeoutMs || 30000,
    });
    setError(null);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    const payload = {
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      auth: draft.auth,
      headers: parseHeadersText(draft.headersText),
      timeoutMs: draft.timeoutMs,
    };
    if (!payload.name || !payload.baseUrl) {
      setError("Name and baseUrl are required");
      setSaving(false);
      return;
    }
    try {
      const url = draft.editingId
        ? `/api/config/api-connections/${draft.editingId}`
        : "/api/config/api-connections";
      const method = draft.editingId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Save failed");
      } else {
        setDraft(null);
        setFlash(draft.editingId ? "Saved" : "Created");
        setTimeout(() => setFlash(null), 2000);
        await reload();
      }
    } catch {
      setError("Network error");
    }
    setSaving(false);
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this connection? Attached custom tools will also be removed.")) return;
    try {
      const res = await fetch(`/api/config/api-connections/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setFlash(
          data.toolsRemoved > 0
            ? `Deleted + removed ${data.toolsRemoved} attached tool(s)`
            : "Deleted"
        );
        setTimeout(() => setFlash(null), 2500);
        await reload();
      } else {
        alert(data.error || "Delete failed");
      }
    } catch {
      alert("Network error");
    }
  };

  const test = async (id: string) => {
    setTesting(id);
    try {
      const res = await fetch(`/api/config/api-connections/${id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.ok) {
        setTestResults((prev) => ({ ...prev, [id]: data.result }));
      } else {
        setTestResults((prev) => ({
          ...prev,
          [id]: { ok: false, ms: 0, error: data.error || "test failed" },
        }));
      }
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, ms: 0, error: "network error" },
      }));
    }
    setTesting(null);
  };

  if (loading) {
    return <p className="text-sm text-text-muted">Loading API connections…</p>;
  }

  return (
    <section className="mt-14" aria-labelledby="api-connections-title">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 mb-4">
        <div className="min-w-0 max-w-2xl">
          <h2 id="api-connections-title" className="font-semibold text-base text-text">
            API Connections
          </h2>
          <p className="text-sm text-text-dim mt-1">
            Configure any HTTP API with a base URL + auth, then build custom tools that call its
            endpoints. Your tools appear in every connected MCP client.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {flash && (
            <span className="text-[11px] font-medium text-green bg-green-bg px-2 py-0.5 rounded-full">
              {flash}
            </span>
          )}
          {!draft && (
            <button
              onClick={startCreate}
              className="text-sm font-medium text-accent bg-bg hover:bg-accent/5 px-3 py-1.5 border border-border rounded-lg"
            >
              + Add API Connection
            </button>
          )}
        </div>
      </div>

      {draft && (
        <DraftForm
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={() => {
            setDraft(null);
            setError(null);
          }}
          saving={saving}
          error={error}
        />
      )}

      {connections.length === 0 && !draft && (
        <p className="border-t border-b border-border py-6 text-sm text-text-dim">
          No API connections yet. Click <strong>+ Add API Connection</strong> to start.
        </p>
      )}

      {connections.length > 0 && (
        <ul className="border-t border-border">
          {connections.map((c) => {
            const probe = testResults[c.id];
            return (
              <li key={c.id} className="border-b border-border">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 sm:px-2 py-4">
                  <span className="text-text-dim shrink-0">
                    <OutlineIcon name="link" size={20} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-[15px] text-text">{c.name}</p>
                      <code className="text-[11px] text-text-muted truncate">{c.baseUrl}</code>
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full text-text-muted bg-bg-muted">
                        {c.auth.type}
                      </span>
                      {probe && (
                        <span
                          className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                            probe.ok ? "text-green bg-green-bg" : "text-red bg-red-bg"
                          }`}
                          title={probe.error || `${probe.status} in ${probe.ms}ms`}
                        >
                          {probe.ok ? `healthy (${probe.status})` : "unreachable"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => test(c.id)}
                      disabled={testing === c.id}
                      className="text-xs text-text-dim hover:text-accent px-2 py-1 rounded disabled:opacity-60"
                    >
                      {testing === c.id ? "…" : "Test"}
                    </button>
                    <button
                      onClick={() => startEdit(c)}
                      className="text-xs text-accent hover:underline px-2 py-1 rounded"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => remove(c.id)}
                      className="text-xs text-red hover:underline px-2 py-1 rounded"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DraftForm({
  draft,
  setDraft,
  onSave,
  onCancel,
  saving,
  error,
}: {
  draft: Draft;
  setDraft: (updater: (d: Draft | null) => Draft | null) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setAuthType = (type: AuthType) => {
    switch (type) {
      case "none":
        set({ auth: { type: "none" } });
        break;
      case "bearer":
        set({ auth: { type: "bearer", token: "" } });
        break;
      case "api_key_header":
        set({ auth: { type: "api_key_header", headerName: "X-Api-Key", value: "" } });
        break;
      case "basic":
        set({ auth: { type: "basic", username: "", password: "" } });
        break;
    }
  };

  return (
    <div className="border border-accent/30 rounded-lg bg-bg p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">
          {draft.editingId ? "Edit connection" : "New API connection"}
        </h3>
        <button onClick={onCancel} className="text-xs text-text-dim hover:text-text">
          Cancel
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium block mb-1.5">Name</label>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Acme CRM"
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1.5">Base URL</label>
          <input
            type="url"
            value={draft.baseUrl}
            onChange={(e) => set({ baseUrl: e.target.value })}
            placeholder="https://api.acme.example.com"
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      <div>
        <label className="text-sm font-medium block mb-1.5">Authentication</label>
        <div className="flex gap-2 mb-3 flex-wrap">
          {(["none", "bearer", "api_key_header", "basic"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setAuthType(t)}
              className={`text-xs font-medium px-3 py-1.5 rounded-md border ${
                draft.auth.type === t
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-text-dim hover:border-border-light"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {draft.auth.type === "bearer" && (
          <input
            type="password"
            value={draft.auth.token}
            onChange={(e) => set({ auth: { type: "bearer", token: e.target.value } })}
            placeholder="token"
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
          />
        )}
        {draft.auth.type === "api_key_header" && (
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={draft.auth.headerName}
              onChange={(e) =>
                set({
                  auth: {
                    type: "api_key_header",
                    headerName: e.target.value,
                    value: (draft.auth as AuthApiKey).value,
                  },
                })
              }
              placeholder="X-Api-Key"
              className="bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
            />
            <input
              type="password"
              value={draft.auth.value}
              onChange={(e) =>
                set({
                  auth: {
                    type: "api_key_header",
                    headerName: (draft.auth as AuthApiKey).headerName,
                    value: e.target.value,
                  },
                })
              }
              placeholder="value"
              className="bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
            />
          </div>
        )}
        {draft.auth.type === "basic" && (
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={draft.auth.username}
              onChange={(e) =>
                set({
                  auth: {
                    type: "basic",
                    username: e.target.value,
                    password: (draft.auth as AuthBasic).password,
                  },
                })
              }
              placeholder="username"
              className="bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
            <input
              type="password"
              value={draft.auth.password}
              onChange={(e) =>
                set({
                  auth: {
                    type: "basic",
                    username: (draft.auth as AuthBasic).username,
                    password: e.target.value,
                  },
                })
              }
              placeholder="password"
              className="bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </div>
        )}
      </div>

      <div>
        <label className="text-sm font-medium block mb-1.5">
          Default headers{" "}
          <span className="text-text-muted text-xs font-normal">(one per line: Name: value)</span>
        </label>
        <textarea
          value={draft.headersText}
          onChange={(e) => set({ headersText: e.target.value })}
          rows={3}
          placeholder="Accept: application/json&#10;X-Client: kebab"
          className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
        />
      </div>

      <div>
        <label className="text-sm font-medium block mb-1.5">
          Timeout <span className="text-text-muted text-xs font-normal">(ms, 1000–60000)</span>
        </label>
        <input
          type="number"
          value={draft.timeoutMs}
          min={1000}
          max={60000}
          onChange={(e) => set({ timeoutMs: Number(e.target.value) || 30000 })}
          className="w-32 bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
      </div>

      {error && (
        <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={onSave}
          disabled={saving}
          className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : draft.editingId ? "Save changes" : "Create connection"}
        </button>
        <button
          onClick={onCancel}
          className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
