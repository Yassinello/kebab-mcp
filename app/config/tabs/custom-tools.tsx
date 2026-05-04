"use client";

import { useState, useEffect, useCallback } from "react";
import { toMsg } from "@/core/error-utils";

/**
 * Custom Tools dashboard tab.
 *
 * MVP scope (matches the v0.1 brief):
 *  - List existing Custom Tools (id, description, last updated)
 *  - "+ New custom tool" → drawer with JSON textarea
 *  - In-drawer test runner: provide inputs as JSON, hit "Run test",
 *    see step-by-step results
 *  - Edit (re-opens drawer pre-filled)
 *  - Delete (with confirm)
 *
 * Deliberately excluded from this MVP — captured as TODOs in the Custom
 * Tools rehydrate notes:
 *  - Visual step builder (drag/drop)
 *  - Template autocomplete
 *  - Conditional branching / loops
 *  - Audit log
 */

// ── Types (mirror src/connectors/custom-tools/types.ts) ───────────────

interface CustomToolInputBase {
  name: string;
  description?: string;
  required?: boolean;
}
type CustomToolInput =
  | (CustomToolInputBase & { type: "string" | "number" | "boolean" })
  | (CustomToolInputBase & { type: "enum"; values: string[] });

interface CustomToolStepTool {
  kind: "tool";
  toolName: string;
  args?: Record<string, unknown>;
  saveAs?: string;
}
interface CustomToolStepTransform {
  kind: "transform";
  template: string;
  saveAs: string;
}
type CustomToolStep = CustomToolStepTool | CustomToolStepTransform;

interface CustomTool {
  id: string;
  description: string;
  destructive: boolean;
  inputs: CustomToolInput[];
  steps: CustomToolStep[];
  createdAt: string;
  updatedAt: string;
}

interface StepRunResult {
  index: number;
  kind: "tool" | "transform";
  label: string;
  ok: boolean;
  durationMs: number;
  preview?: string;
  error?: string;
}
interface RunResult {
  ok: boolean;
  result: string;
  stepResults: StepRunResult[];
  totalDurationMs: number;
  error?: string;
}

// ── Sample template shown in an empty drawer ──────────────────────────

const SAMPLE_TOOL = `{
  "id": "todo_add",
  "description": "Add a task to my Obsidian Tasks/Kanban.md kanban",
  "destructive": true,
  "inputs": [
    {
      "name": "task",
      "type": "string",
      "required": true,
      "description": "The task description"
    },
    {
      "name": "due",
      "type": "string",
      "required": false,
      "description": "ISO date YYYY-MM-DD or empty"
    },
    {
      "name": "priority",
      "type": "enum",
      "values": ["high", "med", "low"],
      "required": false,
      "description": "Task priority"
    }
  ],
  "steps": [
    {
      "kind": "tool",
      "toolName": "vault_read",
      "args": { "path": "Tasks/Kanban.md" },
      "saveAs": "kanban"
    },
    {
      "kind": "transform",
      "template": "{{kanban}}\\n- [ ] {{task}}{{#priority}} #{{priority}}{{/priority}}{{#due}} 📅 {{due}}{{/due}}",
      "saveAs": "newKanban"
    },
    {
      "kind": "tool",
      "toolName": "vault_write",
      "args": { "path": "Tasks/Kanban.md", "content": "{{newKanban}}" }
    }
  ]
}`;

// ── Tab ───────────────────────────────────────────────────────────────

export function CustomToolsTab() {
  const [tools, setTools] = useState<CustomTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState<{ mode: "new" } | { mode: "edit"; tool: CustomTool } | null>(
    null
  );
  const [flash, setFlash] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/custom-tools", { credentials: "include" });
      const data = await res.json();
      if (data.ok) setTools(data.tools || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const onDelete = async (id: string) => {
    if (!confirm(`Delete Custom Tool "${id}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/admin/custom-tools/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setFlash(`Deleted "${id}"`);
        setTimeout(() => setFlash(null), 2000);
        await reload();
      } else {
        alert(data.error || "Delete failed");
      }
    } catch {
      alert("Network error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Custom Tools</h2>
          <p className="text-sm text-text-dim">
            Compose existing Kebab tools into new MCP tools — declarative JSON, no code.
          </p>
        </div>
        <button
          onClick={() => setDrawer({ mode: "new" })}
          className="text-sm font-medium px-4 py-1.5 bg-accent text-white rounded-md hover:bg-accent/90"
        >
          + New custom tool
        </button>
      </div>

      {flash && (
        <div className="bg-accent/10 border border-accent/20 rounded-md p-2 text-xs text-accent">
          {flash}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-dim">Loading…</p>
      ) : tools.length === 0 ? (
        <div className="border border-border border-dashed rounded-lg p-8 text-center">
          <p className="text-sm text-text-dim">
            No Custom Tools yet. Click <strong>+ New custom tool</strong> to compose your first one.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {tools.map((t) => (
            <div
              key={t.id}
              className="border border-border rounded-lg p-4 bg-bg-muted hover:border-border-light transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <code className="text-sm font-mono font-semibold">{t.id}</code>
                    {t.destructive && (
                      <span className="text-[10px] uppercase tracking-wide bg-red/10 text-red px-1.5 py-0.5 rounded">
                        destructive
                      </span>
                    )}
                    <span className="text-[11px] text-text-muted">
                      {t.steps.length} step{t.steps.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="text-sm text-text-dim mb-1">{t.description}</p>
                  <p className="text-[11px] text-text-muted">
                    Updated {new Date(t.updatedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setDrawer({ mode: "edit", tool: t })}
                    className="text-xs font-medium px-3 py-1 border border-border rounded-md text-text-dim hover:text-text"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete(t.id)}
                    className="text-xs font-medium px-3 py-1 border border-red/30 rounded-md text-red hover:bg-red/5"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {drawer && (
        <CustomToolDrawer
          initial={drawer.mode === "edit" ? drawer.tool : null}
          onClose={() => setDrawer(null)}
          onSaved={async () => {
            setDrawer(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────

function CustomToolDrawer({
  initial,
  onClose,
  onSaved,
}: {
  initial: CustomTool | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Strip server-stamped timestamps for the editable JSON.
  const initialJson = initial ? JSON.stringify(stripStamped(initial), null, 2) : SAMPLE_TOOL;

  const [json, setJson] = useState(initialJson);
  const [testInputsJson, setTestInputsJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<RunResult | null>(null);

  const parseJson = ():
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; err: string } => {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, err: "Tool definition must be a JSON object" };
      }
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch (err) {
      return {
        ok: false,
        err: `Invalid JSON: ${toMsg(err)}`,
      };
    }
  };

  const save = async () => {
    setError(null);
    const parsed = parseJson();
    if (!parsed.ok) {
      setError(parsed.err);
      return;
    }
    setSaving(true);
    try {
      const isEdit = !!initial;
      const url = isEdit
        ? `/api/admin/custom-tools/${encodeURIComponent(initial!.id)}`
        : "/api/admin/custom-tools";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(parsed.value),
      });
      const data = await res.json();
      if (!data.ok) {
        const issuesMsg = Array.isArray(data.issues)
          ? `\n${data.issues
              .map(
                (i: { path?: (string | number)[]; message: string }) =>
                  `  • ${(i.path || []).join(".")}: ${i.message}`
              )
              .join("\n")}`
          : "";
        setError(`${data.error || "Save failed"}${issuesMsg}`);
      } else {
        onSaved();
      }
    } catch {
      setError("Network error");
    }
    setSaving(false);
  };

  const runTest = async () => {
    setError(null);
    setTestResult(null);
    const parsed = parseJson();
    if (!parsed.ok) {
      setError(parsed.err);
      return;
    }

    let inputs: Record<string, unknown> = {};
    if (testInputsJson.trim()) {
      try {
        const parsedInputs = JSON.parse(testInputsJson);
        if (
          typeof parsedInputs !== "object" ||
          parsedInputs === null ||
          Array.isArray(parsedInputs)
        ) {
          setError("Test inputs must be a JSON object");
          return;
        }
        inputs = parsedInputs as Record<string, unknown>;
      } catch (err) {
        setError(`Invalid test inputs JSON: ${toMsg(err)}`);
        return;
      }
    }

    // Test runner needs a persisted tool — for unsaved drafts we save to a
    // temporary id, run, then delete. For an existing tool we run directly.
    setTesting(true);
    try {
      const id = (parsed.value as { id?: string }).id;
      if (!id) {
        setError('Test requires a valid "id" in the tool JSON');
        setTesting(false);
        return;
      }

      // If editing an existing tool with the same id, just run it (the
      // saved version on disk wins). Otherwise stage a temporary tool
      // under a __test__ prefix, run, then delete — so the user gets a
      // real end-to-end exercise of the runner without having to commit.
      if (initial && initial.id === id) {
        const res = await fetch(`/api/admin/custom-tools/${encodeURIComponent(id)}/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ inputs }),
        });
        const data = (await res.json()) as RunResult;
        setTestResult(data);
      } else {
        // HI-01 — tempId must start with [a-z] to satisfy
        // customToolIdPattern (`/^[a-z][a-z0-9_]{0,63}$/`). The `t__test_`
        // prefix gives us a deterministic-looking marker (`t__test_*`)
        // while still parsing as a valid id. Length budget: 7 (prefix) +
        // 32 (id slice) + 1 (underscore) + 13 (Date.now base36, e.g.
        // `lpr5w8q1a4`) = 53 chars, comfortably under the 64-char cap.
        const tempId = `t__test_${id.slice(0, 32)}_${Date.now().toString(36)}`;
        const tempPayload = { ...(parsed.value as Record<string, unknown>), id: tempId };
        const create = await fetch("/api/admin/custom-tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(tempPayload),
        });
        const created = await create.json();
        if (!created.ok) {
          setError(created.error || "Failed to stage test tool");
          setTesting(false);
          return;
        }
        try {
          const res = await fetch(`/api/admin/custom-tools/${encodeURIComponent(tempId)}/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ inputs }),
          });
          const data = (await res.json()) as RunResult;
          setTestResult(data);
        } finally {
          // Best-effort cleanup; ignore errors so a 5xx on delete doesn't
          // mask the test result the user actually wants to see.
          await fetch(`/api/admin/custom-tools/${encodeURIComponent(tempId)}`, {
            method: "DELETE",
            credentials: "include",
          }).catch(() => undefined);
        }
      }
    } catch (err) {
      setError(`Network error: ${toMsg(err)}`);
    }
    setTesting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex justify-end">
      <div className="bg-bg border-l border-border w-full max-w-3xl h-full overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-lg">
            {initial ? `Edit "${initial.id}"` : "New Custom Tool"}
          </h3>
          <button onClick={onClose} className="text-sm text-text-dim hover:text-text">
            Close
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium block mb-1.5">
              Tool definition <span className="text-text-muted text-xs font-normal">(JSON)</span>
            </label>
            <textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={20}
              spellCheck={false}
              className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-xs font-mono focus:border-accent focus:outline-none"
            />
          </div>

          <details className="border border-border rounded-md overflow-hidden">
            <summary className="px-3 py-2 bg-bg-muted cursor-pointer text-sm font-medium">
              Test runner
            </summary>
            <div className="p-3 space-y-3">
              <div>
                <label className="text-xs font-medium block mb-1">
                  Test inputs <span className="text-text-muted">(JSON object)</span>
                </label>
                <textarea
                  value={testInputsJson}
                  onChange={(e) => setTestInputsJson(e.target.value)}
                  rows={4}
                  spellCheck={false}
                  placeholder='{"task": "Buy milk", "priority": "high"}'
                  className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-xs font-mono focus:border-accent focus:outline-none"
                />
              </div>
              <button
                onClick={runTest}
                disabled={testing}
                className="text-xs font-medium px-3 py-1.5 bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50"
              >
                {testing ? "Running…" : "Run test"}
              </button>

              {testResult && (
                <div className="space-y-2">
                  <div
                    className={`text-xs font-medium ${testResult.ok ? "text-accent" : "text-red"}`}
                  >
                    {testResult.ok ? "✓ ok" : "✗ failed"} — {testResult.totalDurationMs}ms
                    {testResult.error ? ` — ${testResult.error}` : ""}
                  </div>
                  <div className="space-y-1">
                    {testResult.stepResults.map((s) => (
                      <div
                        key={s.index}
                        className={`text-[11px] font-mono px-2 py-1 rounded ${
                          s.ok ? "bg-bg-muted text-text-dim" : "bg-red/10 text-red"
                        }`}
                      >
                        <div>
                          {s.ok ? "✓" : "✗"} step[{s.index}] {s.kind}:{s.label} — {s.durationMs}ms
                        </div>
                        {s.preview && (
                          <pre className="mt-1 whitespace-pre-wrap break-words text-text-muted">
                            {s.preview}
                          </pre>
                        )}
                        {s.error && (
                          <pre className="mt-1 whitespace-pre-wrap break-words">{s.error}</pre>
                        )}
                      </div>
                    ))}
                  </div>
                  {testResult.ok && (
                    <div>
                      <label className="text-[11px] font-medium text-text-dim block mb-1">
                        Final result
                      </label>
                      <pre className="bg-bg-muted border border-border rounded-md p-2 text-[11px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">
                        {testResult.result}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </details>

          {error && (
            <pre className="bg-red/10 border border-red/20 rounded-md p-3 text-xs text-red whitespace-pre-wrap font-mono">
              {error}
            </pre>
          )}

          <div className="flex items-center gap-3 pt-2 border-t border-border">
            <button
              onClick={save}
              disabled={saving}
              className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
            >
              {saving ? "Saving…" : initial ? "Save changes" : "Create tool"}
            </button>
            <button
              onClick={onClose}
              className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function stripStamped(t: CustomTool): Omit<CustomTool, "createdAt" | "updatedAt"> {
  const { createdAt: _c, updatedAt: _u, ...rest } = t;
  void _c;
  void _u;
  return rest;
}
