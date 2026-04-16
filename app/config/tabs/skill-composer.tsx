"use client";

import { useState, useEffect, useMemo } from "react";

// ── Types ─────────────────────────────────────────────────────────────

interface ToolEntry {
  name: string;
  description: string;
  connector: string;
  connectorLabel: string;
}

interface FieldDescriptor {
  name: string;
  type: "string" | "number" | "boolean" | "enum" | "unknown";
  description: string;
  required: boolean;
  enumValues?: string[];
  default?: unknown;
}

interface ComposerState {
  step: 1 | 2 | 3 | 4;
  // Step 1: tool selection
  selectedTool: string | null;
  selectedToolDesc: string;
  // Step 2: args
  fields: FieldDescriptor[];
  fieldValues: Record<string, string>;
  fieldUsePlaceholder: Record<string, boolean>;
  // Step 3: metadata
  skillName: string;
  skillDescription: string;
  skillTags: string;
}

const initialState: ComposerState = {
  step: 1,
  selectedTool: null,
  selectedToolDesc: "",
  fields: [],
  fieldValues: {},
  fieldUsePlaceholder: {},
  skillName: "",
  skillDescription: "",
  skillTags: "",
};

// ── Main component ────────────────────────────────────────────────────

export function SkillComposer({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [loadingTools, setLoadingTools] = useState(true);
  const [state, setState] = useState<ComposerState>(initialState);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolSearch, setToolSearch] = useState("");

  // Load tool list
  useEffect(() => {
    fetch("/api/config/tool-schema", { credentials: "include" })
      .then((r) => r.json())
      .then((d: { ok: boolean; tools?: ToolEntry[] }) => {
        if (d.ok && d.tools) setTools(d.tools);
      })
      .catch(() => {})
      .finally(() => setLoadingTools(false));
  }, []);

  // Filter tools by search
  const filteredTools = useMemo(() => {
    if (!toolSearch.trim()) return tools;
    const q = toolSearch.toLowerCase();
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.connectorLabel.toLowerCase().includes(q)
    );
  }, [tools, toolSearch]);

  // Select a tool and fetch its schema
  const selectTool = async (tool: ToolEntry) => {
    setLoadingSchema(true);
    setError(null);
    try {
      const res = await fetch(`/api/config/tool-schema?tool=${encodeURIComponent(tool.name)}`, {
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        const fields = (data.fields || []) as FieldDescriptor[];
        const fieldValues: Record<string, string> = {};
        const fieldUsePlaceholder: Record<string, boolean> = {};
        for (const f of fields) {
          fieldValues[f.name] = f.default !== undefined ? String(f.default) : "";
          fieldUsePlaceholder[f.name] = false;
        }
        setState((s) => ({
          ...s,
          step: 2,
          selectedTool: tool.name,
          selectedToolDesc: tool.description,
          fields,
          fieldValues,
          fieldUsePlaceholder,
        }));
      } else {
        setError(data.error || "Failed to load tool schema");
      }
    } catch {
      setError("Network error loading schema");
    }
    setLoadingSchema(false);
  };

  // Generate skill YAML preview
  const yamlPreview = useMemo(() => {
    if (!state.selectedTool) return "";

    const lines: string[] = [];
    lines.push("---");
    if (state.skillName) lines.push(`name: ${state.skillName}`);
    if (state.skillDescription) lines.push(`description: ${state.skillDescription}`);
    if (state.skillTags) lines.push(`tags: [${state.skillTags}]`);
    lines.push("---");
    lines.push("");

    // Build the tool invocation template
    lines.push(`Use the tool \`${state.selectedTool}\` with the following arguments:`);
    lines.push("");

    const args: string[] = [];
    for (const field of state.fields) {
      const usePlaceholder = state.fieldUsePlaceholder[field.name];
      const value = state.fieldValues[field.name];
      if (usePlaceholder || !value) {
        args.push(`- **${field.name}**: {{${field.name}}}`);
      } else {
        args.push(`- **${field.name}**: ${value}`);
      }
    }
    lines.push(...args);

    return lines.join("\n");
  }, [state]);

  // Build the skill arguments from placeholder fields
  const skillArguments = useMemo(() => {
    const args: { name: string; description: string; required: boolean }[] = [];
    for (const field of state.fields) {
      if (state.fieldUsePlaceholder[field.name] || !state.fieldValues[field.name]) {
        args.push({
          name: field.name,
          description: field.description || field.name,
          required: field.required,
        });
      }
    }
    return args;
  }, [state.fields, state.fieldUsePlaceholder, state.fieldValues]);

  // Save the skill
  const saveSkill = async () => {
    if (!state.skillName.trim()) {
      setError("Skill name is required");
      return;
    }
    setSaving(true);
    setError(null);

    // Build content from the preview (without frontmatter)
    const contentLines: string[] = [];
    contentLines.push(`Use the tool \`${state.selectedTool}\` with the following arguments:`);
    contentLines.push("");
    for (const field of state.fields) {
      const usePlaceholder = state.fieldUsePlaceholder[field.name];
      const value = state.fieldValues[field.name];
      if (usePlaceholder || !value) {
        contentLines.push(`- **${field.name}**: {{${field.name}}}`);
      } else {
        contentLines.push(`- **${field.name}**: ${value}`);
      }
    }
    const content = contentLines.join("\n");

    try {
      const res = await fetch("/api/config/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: state.skillName.trim(),
          description: state.skillDescription.trim(),
          content,
          arguments: skillArguments,
          source: { type: "inline" },
        }),
      });
      const data = await res.json();
      if (data.ok) {
        onCreated();
      } else {
        setError(data.error || "Failed to create skill");
      }
    } catch {
      setError("Network error");
    }
    setSaving(false);
  };

  const setField = (name: string, value: string) => {
    setState((s) => ({ ...s, fieldValues: { ...s.fieldValues, [name]: value } }));
  };

  const togglePlaceholder = (name: string) => {
    setState((s) => ({
      ...s,
      fieldUsePlaceholder: { ...s.fieldUsePlaceholder, [name]: !s.fieldUsePlaceholder[name] },
    }));
  };

  return (
    <div className="border border-accent/30 rounded-lg bg-bg p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">
          Skill Composer{" "}
          <span className="text-text-muted font-normal">— Step {state.step} of 4</span>
        </h3>
        <button onClick={onClose} className="text-xs text-text-dim hover:text-text">
          Cancel
        </button>
      </div>

      {/* Step indicators */}
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((n) => (
          <div
            key={n}
            className={`h-1 flex-1 rounded-full transition-colors ${
              n <= state.step ? "bg-accent" : "bg-border"
            }`}
          />
        ))}
      </div>

      {/* Step 1: Tool picker */}
      {state.step === 1 && (
        <div className="space-y-3">
          <p className="text-xs text-text-dim">
            Pick a tool to wrap as a skill. The skill will pre-fill arguments so the LLM can invoke
            it with less context.
          </p>
          <input
            type="text"
            value={toolSearch}
            onChange={(e) => setToolSearch(e.target.value)}
            placeholder="Search tools..."
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
          {loadingTools ? (
            <p className="text-xs text-text-muted">Loading tools...</p>
          ) : (
            <div className="max-h-64 overflow-y-auto border border-border rounded-md divide-y divide-border">
              {filteredTools.length === 0 && (
                <p className="text-xs text-text-muted p-3">No tools match your search.</p>
              )}
              {filteredTools.map((tool) => (
                <button
                  key={tool.name}
                  type="button"
                  onClick={() => selectTool(tool)}
                  disabled={loadingSchema}
                  className="w-full text-left px-3 py-2.5 hover:bg-bg-muted transition-colors disabled:opacity-50"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-medium text-text">{tool.name}</span>
                    <span className="text-[10px] text-text-muted bg-bg-muted px-1.5 py-0.5 rounded">
                      {tool.connectorLabel}
                    </span>
                  </div>
                  <p className="text-[11px] text-text-dim mt-0.5 line-clamp-2">
                    {tool.description}
                  </p>
                </button>
              ))}
            </div>
          )}
          {loadingSchema && <p className="text-xs text-text-muted">Loading schema...</p>}
        </div>
      )}

      {/* Step 2: Args form */}
      {state.step === 2 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs text-text-dim">
              Configure arguments for{" "}
              <code className="font-mono text-text">{state.selectedTool}</code>. Toggle fields to
              become <strong>{"{{placeholders}}"}</strong> that callers fill in at invocation time.
            </p>
          </div>

          {state.fields.length === 0 ? (
            <p className="text-xs text-text-muted">
              This tool has no input parameters. Proceed to metadata.
            </p>
          ) : (
            <div className="space-y-3">
              {state.fields.map((field) => (
                <div key={field.name} className="border border-border rounded-md p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-medium">{field.name}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          field.required ? "bg-red/10 text-red" : "bg-bg-muted text-text-muted"
                        }`}
                      >
                        {field.required ? "required" : "optional"}
                      </span>
                      <span className="text-[10px] text-text-muted bg-bg-muted px-1.5 py-0.5 rounded">
                        {field.type}
                      </span>
                    </div>
                    <label className="text-[11px] text-text-dim flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={state.fieldUsePlaceholder[field.name] || false}
                        onChange={() => togglePlaceholder(field.name)}
                      />
                      placeholder
                    </label>
                  </div>
                  {field.description && (
                    <p className="text-[11px] text-text-dim">{field.description}</p>
                  )}
                  {!state.fieldUsePlaceholder[field.name] && (
                    <>
                      {field.type === "boolean" ? (
                        <select
                          value={state.fieldValues[field.name] || ""}
                          onChange={(e) => setField(field.name, e.target.value)}
                          className="w-full bg-bg-muted border border-border rounded-md px-2 py-1.5 text-xs focus:border-accent focus:outline-none"
                        >
                          <option value="">— leave as placeholder —</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : field.type === "enum" && field.enumValues ? (
                        <select
                          value={state.fieldValues[field.name] || ""}
                          onChange={(e) => setField(field.name, e.target.value)}
                          className="w-full bg-bg-muted border border-border rounded-md px-2 py-1.5 text-xs focus:border-accent focus:outline-none"
                        >
                          <option value="">— leave as placeholder —</option>
                          {field.enumValues.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      ) : field.type === "number" ? (
                        <input
                          type="number"
                          value={state.fieldValues[field.name] || ""}
                          onChange={(e) => setField(field.name, e.target.value)}
                          placeholder={`Enter value or leave blank for {{${field.name}}}`}
                          className="w-full bg-bg-muted border border-border rounded-md px-2 py-1.5 text-xs font-mono focus:border-accent focus:outline-none"
                        />
                      ) : (
                        <input
                          type="text"
                          value={state.fieldValues[field.name] || ""}
                          onChange={(e) => setField(field.name, e.target.value)}
                          placeholder={`Enter value or leave blank for {{${field.name}}}`}
                          className="w-full bg-bg-muted border border-border rounded-md px-2 py-1.5 text-xs font-mono focus:border-accent focus:outline-none"
                        />
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => setState((s) => ({ ...s, step: 3 }))}
              className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90"
            >
              Next: Metadata
            </button>
            <button
              onClick={() => setState(initialState)}
              className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Metadata */}
      {state.step === 3 && (
        <div className="space-y-3">
          <p className="text-xs text-text-dim">
            Name and describe your skill. This is what the LLM sees when choosing which tool to
            call.
          </p>
          <div>
            <label className="text-sm font-medium block mb-1">Name</label>
            <input
              type="text"
              value={state.skillName}
              onChange={(e) => setState((s) => ({ ...s, skillName: e.target.value }))}
              placeholder="e.g., search-my-inbox"
              className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Description</label>
            <input
              type="text"
              value={state.skillDescription}
              onChange={(e) => setState((s) => ({ ...s, skillDescription: e.target.value }))}
              placeholder="e.g., Search my Gmail inbox for recent messages"
              className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">
              Tags <span className="text-text-muted font-normal">(comma-separated, optional)</span>
            </label>
            <input
              type="text"
              value={state.skillTags}
              onChange={(e) => setState((s) => ({ ...s, skillTags: e.target.value }))}
              placeholder="e.g., email, search, productivity"
              className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => setState((s) => ({ ...s, step: 4 }))}
              disabled={!state.skillName.trim()}
              className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
            >
              Next: Preview
            </button>
            <button
              onClick={() => setState((s) => ({ ...s, step: 2 }))}
              className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Preview + Save */}
      {state.step === 4 && (
        <div className="space-y-3">
          <p className="text-xs text-text-dim">
            Review the generated skill. Edit the YAML directly if needed, then save.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Left: summary */}
            <div className="space-y-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                  Skill name
                </p>
                <p className="text-sm font-mono">{state.skillName}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                  Description
                </p>
                <p className="text-xs text-text-dim">{state.skillDescription || "—"}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                  Wraps tool
                </p>
                <p className="text-xs font-mono text-accent">{state.selectedTool}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                  Arguments ({skillArguments.length})
                </p>
                {skillArguments.length === 0 ? (
                  <p className="text-xs text-text-muted italic">
                    All fields pre-filled — no caller input needed.
                  </p>
                ) : (
                  <ul className="text-xs text-text-dim space-y-0.5">
                    {skillArguments.map((a) => (
                      <li key={a.name}>
                        <code className="font-mono text-text">{a.name}</code>
                        {a.required && <span className="text-red"> *</span>}
                        {a.description && (
                          <span className="ml-1.5 text-text-muted">— {a.description}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Right: YAML preview */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted mb-1">
                Generated content
              </p>
              <pre className="text-[11px] font-mono text-text-dim bg-bg-muted border border-border rounded-md p-3 max-h-60 overflow-auto whitespace-pre-wrap">
                {yamlPreview}
              </pre>
            </div>
          </div>

          {error && (
            <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red">
              {error}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={saveSkill}
              disabled={saving}
              className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
            >
              {saving ? "Saving..." : "Create skill"}
            </button>
            <button
              onClick={() => setState((s) => ({ ...s, step: 3 }))}
              className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim"
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
