"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ── Types ──────────────────────────────────────────────────────────────

interface ToolInfo {
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

interface Message {
  id: number;
  role: "user" | "assistant";
  tool: string;
  args: Record<string, unknown>;
  response?: unknown;
  error?: string;
  durationMs?: number;
  timestamp: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function buildArgTemplate(fields: FieldDescriptor[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.default !== undefined) {
      args[f.name] = f.default;
    } else if (f.type === "string") {
      args[f.name] = "";
    } else if (f.type === "number") {
      args[f.name] = 0;
    } else if (f.type === "boolean") {
      args[f.name] = false;
    } else if (f.type === "enum" && f.enumValues?.length) {
      args[f.name] = f.enumValues[0];
    } else {
      args[f.name] = "";
    }
  }
  return args;
}

/** Minimal JSON syntax highlighting for pre blocks. */
function highlightJson(json: string): string {
  return json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/("(?:\\.|[^"\\])*")\s*:/g, '<span style="color:var(--accent,#6d9eff)">$1</span>:')
    .replace(/:\s*("(?:\\.|[^"\\])*")/g, ': <span style="color:#98c379">$1</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:#d19a66">$1</span>')
    .replace(/:\s*(true|false|null)\b/g, ': <span style="color:#c678dd">$1</span>');
}

// ── Component ──────────────────────────────────────────────────────────

export function PlaygroundTab() {
  // Tool list
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loadingTools, setLoadingTools] = useState(true);
  const [toolSearch, setToolSearch] = useState("");

  // Selected tool
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldDescriptor[]>([]);
  const [loadingFields, setLoadingFields] = useState(false);

  // Input
  const [argsJson, setArgsJson] = useState("{}");

  // Conversation
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  // ── Load tools ─────────────────────────────────────────────────────

  useEffect(() => {
    setLoadingTools(true);
    fetch("/api/config/tool-schema", { credentials: "include" })
      .then((r) => r.json())
      .then((d: { ok?: boolean; tools?: ToolInfo[] }) => {
        if (d.ok && d.tools) setTools(d.tools);
      })
      .catch(() => {})
      .finally(() => setLoadingTools(false));
  }, []);

  // ── Group tools by connector ──────────────────────────────────────

  const grouped = useMemo(() => {
    const q = toolSearch.trim().toLowerCase();
    const filtered = tools.filter((t) => {
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
    });
    const map: Record<string, { label: string; tools: ToolInfo[] }> = {};
    for (const t of filtered) {
      if (!map[t.connector]) {
        map[t.connector] = { label: t.connectorLabel, tools: [] };
      }
      map[t.connector].tools.push(t);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [tools, toolSearch]);

  // ── Select a tool ─────────────────────────────────────────────────

  const selectTool = useCallback(async (name: string) => {
    setSelectedTool(name);
    setLoadingFields(true);
    try {
      const res = await fetch(`/api/config/tool-schema?tool=${encodeURIComponent(name)}`, {
        credentials: "include",
      });
      const d = await res.json();
      if (d.ok && d.fields) {
        const f = d.fields as FieldDescriptor[];
        setFields(f);
        setArgsJson(JSON.stringify(buildArgTemplate(f), null, 2));
      } else {
        setFields([]);
        setArgsJson("{}");
      }
    } catch {
      setFields([]);
      setArgsJson("{}");
    }
    setLoadingFields(false);
  }, []);

  // ── Send ──────────────────────────────────────────────────────────

  const send = useCallback(async () => {
    if (!selectedTool || sending) return;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: "assistant",
          tool: selectedTool,
          args: {},
          error: "Invalid JSON in arguments field",
          timestamp: new Date().toISOString(),
        },
      ]);
      return;
    }

    const userMsg: Message = {
      id: nextId.current++,
      role: "user",
      tool: selectedTool,
      args,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setSending(true);

    try {
      const res = await fetch("/api/config/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ toolName: selectedTool, args, confirm: true }),
      });
      const data = await res.json();
      const assistantMsg: Message = {
        id: nextId.current++,
        role: "assistant",
        tool: selectedTool,
        args,
        response: data.ok ? data.data : undefined,
        error: data.ok ? undefined : data.error || "Unknown error",
        durationMs: data.durationMs,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: "assistant",
          tool: selectedTool,
          args,
          error: err instanceof Error ? err.message : "Network error",
          timestamp: new Date().toISOString(),
        },
      ]);
    }

    setSending(false);
  }, [selectedTool, argsJson, sending]);

  // Auto-scroll to newest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Clear ─────────────────────────────────────────────────────────

  const clearHistory = () => {
    setMessages([]);
    nextId.current = 1;
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="flex gap-4 h-[calc(100vh-200px)] min-h-[400px]">
      {/* Left: Tool picker (30%) */}
      <div className="w-[30%] min-w-[220px] flex flex-col border border-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-border bg-bg-muted/30">
          <input
            type="text"
            placeholder="Search tools..."
            value={toolSearch}
            onChange={(e) => setToolSearch(e.target.value)}
            className="w-full bg-bg border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadingTools ? (
            <p className="text-xs text-text-muted p-3">Loading tools...</p>
          ) : grouped.length === 0 ? (
            <p className="text-xs text-text-muted p-3">No tools found.</p>
          ) : (
            grouped.map(([connId, group]) => (
              <div key={connId}>
                <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-3 pt-3 pb-1">
                  {group.label}
                </p>
                {group.tools.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => selectTool(t.name)}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-bg-muted/50 transition-colors ${
                      selectedTool === t.name
                        ? "bg-accent/10 text-accent border-l-2 border-accent"
                        : "text-text-dim"
                    }`}
                  >
                    <span className="font-mono block truncate">{t.name}</span>
                    <span className="text-[10px] text-text-muted block truncate mt-0.5">
                      {t.description}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right: Chat area (70%) */}
      <div className="flex-1 flex flex-col border border-border rounded-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-bg-muted/30">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold truncate">
              {selectedTool ? selectedTool : "Select a tool"}
            </span>
            {selectedTool && fields.length > 0 && !loadingFields && (
              <span className="text-[10px] text-text-muted">
                {fields.filter((f) => f.required).length} required,{" "}
                {fields.filter((f) => !f.required).length} optional
              </span>
            )}
          </div>
          {messages.length > 0 && (
            <button
              onClick={clearHistory}
              className="text-xs text-text-dim hover:text-red px-2 py-1 rounded"
            >
              Clear
            </button>
          )}
        </div>

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-text-muted">
                {selectedTool
                  ? "Fill in the arguments below and click Send."
                  : "Pick a tool from the sidebar to get started."}
              </p>
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`rounded-lg px-4 py-3 text-xs ${
                msg.role === "user"
                  ? "bg-accent/5 border border-accent/20 ml-8"
                  : msg.error
                    ? "bg-red-bg border border-red/20 mr-8"
                    : "bg-bg-muted border border-border mr-8"
              }`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="font-semibold text-[10px] uppercase tracking-wide">
                  {msg.role === "user" ? "Request" : "Response"}
                </span>
                <span className="font-mono text-accent text-[10px]">{msg.tool}</span>
                {msg.durationMs !== undefined && (
                  <span className="text-text-muted text-[10px]">{msg.durationMs}ms</span>
                )}
                <span className="text-text-muted text-[10px] ml-auto">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
              </div>
              {msg.role === "user" ? (
                <pre className="font-mono text-[11px] whitespace-pre-wrap break-all max-h-40 overflow-auto">
                  {JSON.stringify(msg.args, null, 2)}
                </pre>
              ) : msg.error ? (
                <p className="text-red">{msg.error}</p>
              ) : (
                <pre
                  className="font-mono text-[11px] whitespace-pre-wrap break-all max-h-96 overflow-auto"
                  dangerouslySetInnerHTML={{
                    __html: highlightJson(JSON.stringify(msg.response, null, 2)),
                  }}
                />
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="border-t border-border px-4 py-3 space-y-2 bg-bg-muted/20">
          {loadingFields ? (
            <p className="text-xs text-text-muted">Loading schema...</p>
          ) : !selectedTool ? (
            <p className="text-xs text-text-muted">Select a tool from the sidebar.</p>
          ) : (
            <>
              {fields.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1">
                  {fields.map((f) => (
                    <span
                      key={f.name}
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        f.required ? "bg-accent/10 text-accent" : "bg-bg-muted text-text-muted"
                      }`}
                      title={f.description || f.name}
                    >
                      {f.name}
                      {f.required ? "*" : ""}
                      <span className="text-text-muted ml-0.5">:{f.type}</span>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                value={argsJson}
                onChange={(e) => setArgsJson(e.target.value)}
                rows={Math.min(8, Math.max(3, argsJson.split("\n").length))}
                className="w-full bg-bg border border-border rounded-md px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 resize-y"
                placeholder='{ "key": "value" }'
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-text-muted">Ctrl+Enter to send</span>
                <button
                  onClick={send}
                  disabled={sending || !selectedTool}
                  className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
                >
                  {sending ? "Running..." : "Send"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
