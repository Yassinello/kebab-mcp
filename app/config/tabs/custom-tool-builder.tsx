"use client";

import { useState, useEffect } from "react";
import { inferJsonSchema } from "./lib/infer-schema-client";

interface ApiConnectionSummary {
  id: string;
  name: string;
  baseUrl: string;
}

interface ToolArg {
  name: string;
  description?: string;
  required?: boolean;
  type?: "string" | "number" | "boolean";
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface ToolDraft {
  connectionId: string;
  name: string;
  description: string;
  method: HttpMethod;
  pathTemplate: string;
  arguments: ToolArg[];
  queryPairs: Array<{ key: string; value: string }>;
  bodyTemplate: string;
  readOrWrite: "read" | "write";
  destructive: boolean;
  timeoutMs: number;
}

const emptyDraft = (connectionId: string = ""): ToolDraft => ({
  connectionId,
  name: "",
  description: "",
  method: "GET",
  pathTemplate: "",
  arguments: [],
  queryPairs: [],
  bodyTemplate: "",
  readOrWrite: "read",
  destructive: false,
  timeoutMs: 30000,
});

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export function CustomToolBuilder({ onClose, onCreated }: Props) {
  const [connections, setConnections] = useState<ApiConnectionSummary[]>([]);
  const [step, setStep] = useState<"pick-method" | "edit" | "test-schema">("pick-method");
  const [draft, setDraft] = useState<ToolDraft>(emptyDraft());
  const [curlText, setCurlText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // test-schema step state
  const [testArgs, setTestArgs] = useState<Record<string, string>>({});
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleResult, setSampleResult] = useState<{
    ok: boolean;
    status: number;
    body: string;
    truncated: boolean;
    url: string;
  } | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [outputSchemaText, setOutputSchemaText] = useState("");
  const [schemaError, setSchemaError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config/api-connections", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setConnections(d.connections || []);
          if ((d.connections || []).length > 0 && !draft.connectionId) {
            setDraft((prev) => ({ ...prev, connectionId: d.connections[0].id }));
          }
        }
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => setLoading(false));
    // Intentionally run once — the first-connection seed is a mount-time concern.
  }, []);

  const importFromCurl = async () => {
    if (!curlText.trim()) return;
    setError(null);
    try {
      const res = await fetch("/api/config/api-tools/parse-curl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ curl: curlText }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Parse failed");
        return;
      }
      const d = data.draft as {
        baseUrl: string;
        method: HttpMethod;
        pathTemplate: string;
        queryTemplate: Record<string, string>;
        bodyTemplate: string;
      };
      // Match baseUrl against existing connection, or suggest creating one.
      const match = connections.find((c) => d.baseUrl.startsWith(c.baseUrl));
      setDraft((prev) => ({
        ...prev,
        connectionId: match?.id ?? prev.connectionId,
        method: d.method,
        pathTemplate: d.pathTemplate,
        bodyTemplate: d.bodyTemplate,
        queryPairs: Object.entries(d.queryTemplate).map(([key, value]) => ({ key, value })),
      }));
      if (!match) {
        setError(
          `cURL host "${d.baseUrl}" does not match any existing API Connection. Pick or create one.`
        );
      }
      setStep("edit");
    } catch {
      setError("Network error");
    }
  };

  const blankTemplate = () => {
    setStep("edit");
  };

  const addArg = () => {
    setDraft((prev) => ({
      ...prev,
      arguments: [
        ...prev.arguments,
        { name: "", description: "", required: false, type: "string" },
      ],
    }));
  };

  const updateArg = (idx: number, patch: Partial<ToolArg>) => {
    setDraft((prev) => ({
      ...prev,
      arguments: prev.arguments.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    }));
  };

  const removeArg = (idx: number) => {
    setDraft((prev) => ({
      ...prev,
      arguments: prev.arguments.filter((_, i) => i !== idx),
    }));
  };

  const addQueryPair = () => {
    setDraft((prev) => ({
      ...prev,
      queryPairs: [...prev.queryPairs, { key: "", value: "" }],
    }));
  };
  const updateQueryPair = (idx: number, patch: Partial<{ key: string; value: string }>) => {
    setDraft((prev) => ({
      ...prev,
      queryPairs: prev.queryPairs.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
    }));
  };
  const removeQueryPair = (idx: number) => {
    setDraft((prev) => ({
      ...prev,
      queryPairs: prev.queryPairs.filter((_, i) => i !== idx),
    }));
  };

  const buildPayload = (outputSchema?: Record<string, unknown>) => {
    const queryTemplate: Record<string, string> = {};
    for (const p of draft.queryPairs) {
      if (p.key.trim()) queryTemplate[p.key.trim()] = p.value;
    }
    return {
      connectionId: draft.connectionId,
      name: draft.name.trim(),
      description: draft.description.trim(),
      method: draft.method,
      pathTemplate: draft.pathTemplate,
      arguments: draft.arguments
        .filter((a) => a.name.trim())
        .map((a) => ({
          name: a.name.trim(),
          description: a.description || "",
          required: !!a.required,
          type: a.type || "string",
        })),
      queryTemplate,
      bodyTemplate: draft.bodyTemplate,
      readOrWrite: draft.readOrWrite,
      destructive: draft.destructive,
      timeoutMs: draft.timeoutMs,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
    };
  };

  const save = async (outputSchema?: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    const payload = buildPayload(outputSchema);
    if (!payload.connectionId || !payload.name) {
      setError("Connection and tool name are required.");
      setSaving(false);
      return;
    }
    try {
      const res = await fetch("/api/config/api-tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Save failed");
      } else {
        onCreated();
      }
    } catch {
      setError("Network error");
    }
    setSaving(false);
  };

  // ── test-schema step helpers ──────────────────────────────────────────

  const fetchSample = async () => {
    setSampleLoading(true);
    setSampleError(null);
    setSampleResult(null);

    const queryTemplate: Record<string, string> = {};
    for (const p of draft.queryPairs) {
      if (p.key.trim()) queryTemplate[p.key.trim()] = p.value;
    }

    try {
      const res = await fetch("/api/config/api-tools/sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          connectionId: draft.connectionId,
          toolDraft: {
            method: draft.method,
            pathTemplate: draft.pathTemplate,
            arguments: draft.arguments
              .filter((a) => a.name.trim())
              .map((a) => ({
                name: a.name.trim(),
                description: a.description || "",
                required: !!a.required,
                type: a.type || "string",
              })),
            queryTemplate,
            bodyTemplate: draft.bodyTemplate,
            timeoutMs: draft.timeoutMs,
          },
          testArgs,
        }),
      });
      const data = await res.json();
      if (!data.ok && data.error) {
        setSampleError(data.error);
      } else {
        setSampleResult(data);
      }
    } catch {
      setSampleError("Network error");
    }
    setSampleLoading(false);
  };

  const inferSchema = () => {
    setSchemaError(null);
    if (!sampleResult?.body) {
      setSchemaError("Fetch a sample first.");
      return;
    }
    try {
      const parsed = JSON.parse(sampleResult.body);
      const schema = inferJsonSchema(parsed);
      setOutputSchemaText(JSON.stringify(schema, null, 2));
    } catch {
      setSchemaError("Response body is not valid JSON — cannot infer schema.");
    }
  };

  const saveWithSchema = async () => {
    setSchemaError(null);
    let parsedSchema: Record<string, unknown> | undefined;
    if (outputSchemaText.trim()) {
      try {
        const parsed = JSON.parse(outputSchemaText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          setSchemaError("Output schema must be a JSON object.");
          return;
        }
        parsedSchema = parsed as Record<string, unknown>;
      } catch {
        setSchemaError("Invalid JSON in output schema.");
        return;
      }
    }
    await save(parsedSchema);
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-bg border border-border rounded-lg p-6">Loading…</div>
      </div>
    );
  }

  if (connections.length === 0) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-bg border border-border rounded-lg p-6 max-w-md w-full">
          <h3 className="font-semibold mb-2">No API Connections yet</h3>
          <p className="text-sm text-text-dim mb-4">
            Custom tools attach to an API Connection. Create one first in the{" "}
            <strong>Connectors</strong> tab, then come back.
          </p>
          <button
            onClick={onClose}
            className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-bg border border-border rounded-lg p-6 max-w-3xl w-full my-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-lg">New Custom Tool</h3>
          <button onClick={onClose} className="text-sm text-text-dim hover:text-text">
            Cancel
          </button>
        </div>

        {step === "pick-method" ? (
          <div className="space-y-6">
            <div>
              <h4 className="text-sm font-semibold mb-2">Start from a cURL command</h4>
              <textarea
                value={curlText}
                onChange={(e) => setCurlText(e.target.value)}
                rows={4}
                placeholder={`curl -X POST https://api.example.com/v1/widgets \\\n  -H "Authorization: Bearer TOKEN" \\\n  -d '{"name":"foo"}'`}
                className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
              />
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={importFromCurl}
                  disabled={!curlText.trim()}
                  className="text-xs font-medium px-3 py-1.5 bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50"
                >
                  Parse cURL →
                </button>
                <span className="text-[11px] text-text-muted">
                  Pre-fills method, path, headers, body.
                </span>
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <h4 className="text-sm font-semibold mb-2">Or start from blank</h4>
              <button
                onClick={blankTemplate}
                className="text-xs font-medium px-3 py-1.5 border border-border rounded-md text-text-dim hover:text-text"
              >
                Blank template →
              </button>
            </div>

            {error && (
              <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red">
                {error}
              </div>
            )}
          </div>
        ) : step === "test-schema" ? (
          <div className="space-y-4">
            <p className="text-sm text-text-dim">
              Optionally fetch a sample response to infer an output schema. The schema is stored
              with the tool and enables structured content in MCP responses.
            </p>

            {/* Test args */}
            {draft.arguments.filter((a) => a.name.trim()).length > 0 && (
              <div>
                <label className="text-sm font-medium block mb-1.5">Test arguments</label>
                <div className="space-y-2">
                  {draft.arguments
                    .filter((a) => a.name.trim())
                    .map((a) => (
                      <div key={a.name} className="grid grid-cols-[120px_1fr] gap-2 items-center">
                        <span className="text-xs font-mono text-text-dim">{a.name}</span>
                        <input
                          type="text"
                          value={testArgs[a.name] ?? ""}
                          onChange={(e) =>
                            setTestArgs((prev) => ({ ...prev, [a.name]: e.target.value }))
                          }
                          placeholder={`value for ${a.name}`}
                          className="bg-bg-muted border border-border rounded-md px-2 py-1 text-xs font-mono focus:border-accent focus:outline-none"
                        />
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Fetch sample */}
            <div className="flex items-center gap-2">
              <button
                onClick={fetchSample}
                disabled={sampleLoading}
                className="text-xs font-medium px-3 py-1.5 bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50"
              >
                {sampleLoading ? "Fetching…" : "Fetch sample"}
              </button>
              {sampleResult && (
                <span className="text-xs text-text-dim">
                  HTTP {sampleResult.status} — {sampleResult.url}
                  {sampleResult.truncated && " [truncated]"}
                </span>
              )}
            </div>

            {sampleError && (
              <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red">
                {sampleError}
              </div>
            )}

            {/* Sample body preview */}
            {sampleResult?.body && (
              <div>
                <label className="text-xs font-medium text-text-dim block mb-1">
                  Response preview
                </label>
                <pre className="bg-bg-muted border border-border rounded-md px-3 py-2 text-xs font-mono overflow-auto max-h-32 whitespace-pre-wrap">
                  {sampleResult.body.slice(0, 2000)}
                  {sampleResult.body.length > 2000 && "\n…"}
                </pre>
              </div>
            )}

            {/* Infer schema */}
            <div className="flex items-center gap-2">
              <button
                onClick={inferSchema}
                disabled={!sampleResult?.body}
                className="text-xs font-medium px-3 py-1.5 border border-border rounded-md text-text-dim hover:text-text disabled:opacity-50"
              >
                Infer schema
              </button>
              <span className="text-[11px] text-text-muted">
                Generates JSON Schema from the sample response.
              </span>
            </div>

            {/* Editable schema textarea */}
            <div>
              <label className="text-sm font-medium block mb-1.5">
                Output schema{" "}
                <span className="text-text-muted text-xs font-normal">(JSON Schema, editable)</span>
              </label>
              <textarea
                value={outputSchemaText}
                onChange={(e) => setOutputSchemaText(e.target.value)}
                rows={8}
                placeholder='{"type":"object","properties":{"id":{"type":"number"},"name":{"type":"string"}},"required":["id","name"]}'
                className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
              />
            </div>

            {schemaError && (
              <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red">
                {schemaError}
              </div>
            )}

            {error && (
              <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red">
                {error}
              </div>
            )}

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={saveWithSchema}
                disabled={saving}
                className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save with schema"}
              </button>
              <button
                onClick={() => save(undefined)}
                disabled={saving}
                className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim disabled:opacity-60"
              >
                Skip
              </button>
              <button
                onClick={() => setStep("edit")}
                className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim"
              >
                ← Back
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium block mb-1.5">Connection</label>
                <select
                  value={draft.connectionId}
                  onChange={(e) => setDraft((prev) => ({ ...prev, connectionId: e.target.value }))}
                  className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
                >
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.baseUrl})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium block mb-1.5">Tool name</label>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  placeholder="crm_get_company"
                  className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium block mb-1.5">Description</label>
              <input
                type="text"
                value={draft.description}
                onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))}
                placeholder="Fetch a company record from the CRM by id"
                className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-[120px_1fr] gap-2">
              <select
                value={draft.method}
                onChange={(e) => setDraft((p) => ({ ...p, method: e.target.value as HttpMethod }))}
                className="bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
              >
                {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={draft.pathTemplate}
                onChange={(e) => setDraft((p) => ({ ...p, pathTemplate: e.target.value }))}
                placeholder="/v1/companies/{{id}}"
                className="bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium">Arguments</label>
                <button
                  type="button"
                  onClick={addArg}
                  className="text-xs text-accent hover:underline"
                >
                  + Add arg
                </button>
              </div>
              {draft.arguments.length === 0 && (
                <p className="text-xs text-text-muted">
                  No arguments. Reference them in path/query/body via {"{{name}}"}.
                </p>
              )}
              <div className="space-y-2">
                {draft.arguments.map((a, i) => (
                  <div key={i} className="grid grid-cols-[1fr_2fr_90px_80px_auto] gap-2">
                    <input
                      type="text"
                      value={a.name}
                      onChange={(e) => updateArg(i, { name: e.target.value })}
                      placeholder="name"
                      className="bg-bg-muted border border-border rounded-md px-2 py-1 text-xs font-mono focus:border-accent focus:outline-none"
                    />
                    <input
                      type="text"
                      value={a.description || ""}
                      onChange={(e) => updateArg(i, { description: e.target.value })}
                      placeholder="description (shown to LLM)"
                      className="bg-bg-muted border border-border rounded-md px-2 py-1 text-xs focus:border-accent focus:outline-none"
                    />
                    <select
                      value={a.type || "string"}
                      onChange={(e) =>
                        updateArg(i, {
                          type: e.target.value as "string" | "number" | "boolean",
                        })
                      }
                      className="bg-bg-muted border border-border rounded-md px-2 py-1 text-xs focus:border-accent focus:outline-none"
                    >
                      <option value="string">string</option>
                      <option value="number">number</option>
                      <option value="boolean">boolean</option>
                    </select>
                    <label className="text-xs flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!a.required}
                        onChange={(e) => updateArg(i, { required: e.target.checked })}
                      />
                      req.
                    </label>
                    <button
                      type="button"
                      onClick={() => removeArg(i)}
                      className="text-xs text-red hover:underline"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium">Query parameters</label>
                <button
                  type="button"
                  onClick={addQueryPair}
                  className="text-xs text-accent hover:underline"
                >
                  + Add
                </button>
              </div>
              {draft.queryPairs.length === 0 && (
                <p className="text-xs text-text-muted">No query params.</p>
              )}
              {draft.queryPairs.map((p, i) => (
                <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2 mb-2">
                  <input
                    type="text"
                    value={p.key}
                    onChange={(e) => updateQueryPair(i, { key: e.target.value })}
                    placeholder="key"
                    className="bg-bg-muted border border-border rounded-md px-2 py-1 text-xs font-mono focus:border-accent focus:outline-none"
                  />
                  <input
                    type="text"
                    value={p.value}
                    onChange={(e) => updateQueryPair(i, { value: e.target.value })}
                    placeholder="value or {{arg}}"
                    className="bg-bg-muted border border-border rounded-md px-2 py-1 text-xs font-mono focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeQueryPair(i)}
                    className="text-xs text-red hover:underline"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {(draft.method === "POST" || draft.method === "PUT" || draft.method === "PATCH") && (
              <div>
                <label className="text-sm font-medium block mb-1.5">
                  Body template{" "}
                  <span className="text-text-muted text-xs font-normal">(use {"{{arg}}"})</span>
                </label>
                <textarea
                  value={draft.bodyTemplate}
                  onChange={(e) => setDraft((p) => ({ ...p, bodyTemplate: e.target.value }))}
                  rows={4}
                  placeholder='{"name": "{{name}}"}'
                  className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
                />
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="text-sm font-medium block mb-1.5">Read or write</label>
                <select
                  value={draft.readOrWrite}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, readOrWrite: e.target.value as "read" | "write" }))
                  }
                  className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
                >
                  <option value="read">read</option>
                  <option value="write">write</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm mt-7">
                <input
                  type="checkbox"
                  checked={draft.destructive}
                  onChange={(e) => setDraft((p) => ({ ...p, destructive: e.target.checked }))}
                />
                destructive (MCP prompts)
              </label>
              <div>
                <label className="text-sm font-medium block mb-1.5">Timeout (ms)</label>
                <input
                  type="number"
                  value={draft.timeoutMs}
                  min={1000}
                  max={60000}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, timeoutMs: Number(e.target.value) || 30000 }))
                  }
                  className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
                />
              </div>
            </div>

            {error && (
              <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red">
                {error}
              </div>
            )}

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => setStep("test-schema")}
                className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90"
              >
                Next: Test &amp; schema →
              </button>
              <button
                onClick={() => setStep("pick-method")}
                className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim"
              >
                ← Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
