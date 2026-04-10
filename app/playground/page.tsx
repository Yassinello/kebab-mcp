"use client";

import { useState, useEffect } from "react";

interface ToolInfo {
  name: string;
  description: string;
}

interface PackInfo {
  id: string;
  label: string;
  enabled: boolean;
  tools: ToolInfo[];
}

export default function PlaygroundPage() {
  const [packs, setPacks] = useState<PackInfo[]>([]);
  const [selectedTool, setSelectedTool] = useState("");
  const [paramsJson, setParamsJson] = useState("{}");
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load tools from admin status API
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") || "";
    fetch(`/api/admin/status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.json())
      .then((data) => {
        setPacks(data.packs?.filter((p: PackInfo) => p.enabled) || []);
      })
      .catch(() => setError("Failed to load tools. Check admin auth."));
  }, []);

  const allTools = packs.flatMap((p) => p.tools);

  async function callTool() {
    if (!selectedTool) return;
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const params = JSON.parse(paramsJson);
      const token = new URLSearchParams(window.location.search).get("token") || "";
      const res = await fetch("/api/admin/call", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ tool: selectedTool, params }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setResult(JSON.stringify(data.result, null, 2));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Call failed");
    } finally {
      setLoading(false);
    }
  }

  const selectedInfo = allTools.find((t) => t.name === selectedTool);

  return (
    <div className="container">
      <header className="header">
        <div>
          <h1 className="header-title">Tool Playground</h1>
          <p className="header-subtitle">Test any active tool directly from the dashboard</p>
        </div>
        <div className="header-badges">
          <span className="badge badge-blue">{allTools.length} tools available</span>
        </div>
      </header>

      {/* Tool selector */}
      <section className="section">
        <div className="tool-card">
          <label
            style={{
              display: "block",
              fontSize: "0.8rem",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginBottom: "0.5rem",
            }}
          >
            Tool
          </label>
          <select
            value={selectedTool}
            onChange={(e) => {
              setSelectedTool(e.target.value);
              setResult(null);
              setError(null);
            }}
            style={{
              width: "100%",
              background: "var(--bg-input)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              padding: "0.6rem 1rem",
              color: "var(--text)",
              fontSize: "0.9rem",
              fontFamily: "var(--font-mono)",
            }}
          >
            <option value="">Select a tool...</option>
            {packs.map((pack) => (
              <optgroup key={pack.id} label={pack.label}>
                {pack.tools.map((tool) => (
                  <option key={tool.name} value={tool.name}>
                    {tool.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          {selectedInfo && (
            <p style={{ color: "var(--text-dim)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
              {selectedInfo.description.slice(0, 150)}
              {selectedInfo.description.length > 150 ? "..." : ""}
            </p>
          )}
        </div>
      </section>

      {/* Params input */}
      <section className="section">
        <div className="tool-card">
          <label
            style={{
              display: "block",
              fontSize: "0.8rem",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginBottom: "0.5rem",
            }}
          >
            Parameters (JSON)
          </label>
          <textarea
            value={paramsJson}
            onChange={(e) => setParamsJson(e.target.value)}
            rows={5}
            style={{
              width: "100%",
              background: "var(--bg-input)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              padding: "0.75rem 1rem",
              color: "var(--text)",
              fontSize: "0.85rem",
              fontFamily: "var(--font-mono)",
              lineHeight: 1.6,
              resize: "vertical",
            }}
            placeholder='{"query": "example"}'
          />

          <button
            onClick={callTool}
            disabled={!selectedTool || loading}
            style={{
              marginTop: "1rem",
              background: loading ? "var(--text-muted)" : "var(--accent)",
              color: "white",
              border: "none",
              padding: "0.6rem 1.5rem",
              borderRadius: "8px",
              cursor: selectedTool && !loading ? "pointer" : "not-allowed",
              fontSize: "0.9rem",
              fontWeight: 600,
            }}
          >
            {loading ? "Running..." : "Call Tool"}
          </button>
        </div>
      </section>

      {/* Result */}
      {(result || error) && (
        <section className="section">
          <div className="tool-card">
            <div className="tool-header">
              <span className="tool-name">Result</span>
              <span className={`badge ${error ? "badge-dim" : "badge-green"}`}>
                {error ? "Error" : "Success"}
              </span>
            </div>
            <pre
              style={{
                background: "var(--bg-input)",
                borderRadius: "8px",
                padding: "1rem",
                fontSize: "0.82rem",
                fontFamily: "var(--font-mono)",
                color: error ? "var(--red)" : "var(--text-dim)",
                overflow: "auto",
                maxHeight: "400px",
                whiteSpace: "pre-wrap",
                marginTop: "0.75rem",
              }}
            >
              {error || result}
            </pre>
          </div>
        </section>
      )}

      <footer className="footer">
        <a href="/" style={{ color: "var(--accent)", textDecoration: "none" }}>
          Back to Dashboard
        </a>
      </footer>
    </div>
  );
}
