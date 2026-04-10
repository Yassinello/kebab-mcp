import { googlePack } from "@/packs/google/manifest";
import { vaultPack } from "@/packs/vault/manifest";
import { browserPack } from "@/packs/browser/manifest";
import { adminPack } from "@/packs/admin/manifest";
import type { PackManifest } from "@/core/types";

/**
 * Public packs listing — no auth required.
 * Shows available packs and their tools without revealing config state.
 */

const ALL_PACKS: PackManifest[] = [googlePack, vaultPack, browserPack, adminPack];

export default function PacksPage() {
  const totalTools = ALL_PACKS.reduce((s, p) => s + p.tools.length, 0);

  return (
    <div className="container">
      <header className="header">
        <div>
          <h1 className="header-title">MyMCP Tool Packs</h1>
          <p className="header-subtitle">
            {ALL_PACKS.length} packs, {totalTools} tools available
          </p>
        </div>
        <div className="header-badges">
          <a
            href="https://github.com/Yassinello/mymcp"
            target="_blank"
            rel="noopener"
            className="badge badge-blue"
            style={{ textDecoration: "none" }}
          >
            GitHub
          </a>
        </div>
      </header>

      {ALL_PACKS.map((pack) => (
        <section key={pack.id} className="section">
          <div className="tool-card">
            <div className="tool-header">
              <span className="tool-name">{pack.label}</span>
              <span className="badge badge-blue">{pack.tools.length} tools</span>
            </div>
            <p className="tool-desc">{pack.description}</p>

            <div style={{ marginTop: "1rem" }}>
              <p
                style={{
                  fontSize: "0.8rem",
                  color: "var(--text-muted)",
                  marginBottom: "0.5rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Required env vars
              </p>
              <div className="usecase-tags">
                {pack.requiredEnvVars.length > 0 ? (
                  pack.requiredEnvVars.map((v) => (
                    <code
                      key={v}
                      style={{
                        background: "var(--bg-input)",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        fontSize: "0.78rem",
                        color: "var(--yellow)",
                      }}
                    >
                      {v}
                    </code>
                  ))
                ) : (
                  <span style={{ fontSize: "0.85rem", color: "var(--green)" }}>
                    Always active — no credentials needed
                  </span>
                )}
              </div>
            </div>

            <div style={{ marginTop: "1rem" }}>
              <p
                style={{
                  fontSize: "0.8rem",
                  color: "var(--text-muted)",
                  marginBottom: "0.5rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Tools
              </p>
              {pack.tools.map((tool) => (
                <div
                  key={tool.name}
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    padding: "0.4rem 0",
                    borderBottom: "1px solid var(--border)",
                    alignItems: "baseline",
                  }}
                >
                  <code
                    style={{
                      color: "var(--accent)",
                      fontSize: "0.82rem",
                      fontWeight: 600,
                      minWidth: "160px",
                      flexShrink: 0,
                    }}
                  >
                    {tool.name}
                  </code>
                  <span style={{ color: "var(--text-dim)", fontSize: "0.82rem" }}>
                    {tool.deprecated ? (
                      <span style={{ color: "var(--yellow)" }}>[Deprecated] </span>
                    ) : null}
                    {tool.description.slice(0, 120)}
                    {tool.description.length > 120 ? "..." : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}

      <footer className="footer">
        <a
          href="https://github.com/Yassinello/mymcp"
          style={{ color: "var(--accent)", textDecoration: "none" }}
        >
          MyMCP on GitHub
        </a>
        {" — "}
        Open Source Personal MCP Framework
      </footer>
    </div>
  );
}
