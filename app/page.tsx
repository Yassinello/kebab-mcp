import { headers } from "next/headers";
import { checkAdminAuth } from "@/core/auth";
import { resolveRegistry } from "@/core/registry";
import { getInstanceConfig } from "@/core/config";
import { getRecentLogs } from "@/core/logging";
import { ConfigBlock } from "./config-block";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Auth check — construct a minimal Request from incoming headers
  const headersList = await headers();
  const authHeader = headersList.get("authorization") || "";
  const fakeReq = new Request("http://localhost", {
    headers: { authorization: authHeader },
  });

  // Check for token in URL query (for simple browser access)
  // Next.js doesn't expose query params in server components easily,
  // so we check the x-forwarded-* or referer for token
  const adminToken = (process.env.ADMIN_AUTH_TOKEN || process.env.MCP_AUTH_TOKEN)?.trim();

  // For the dashboard, we allow access if no admin token is configured
  // Otherwise, the API endpoints handle auth
  if (adminToken) {
    const authError = checkAdminAuth(fakeReq);
    if (authError) {
      return (
        <div className="container">
          <header className="header">
            <div>
              <h1 className="header-title">MyMCP</h1>
              <p className="header-subtitle">Authentication required</p>
            </div>
          </header>
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "2rem",
              textAlign: "center",
            }}
          >
            <p style={{ color: "var(--text-dim)", marginBottom: "1rem" }}>
              Access this dashboard via the admin status API:
            </p>
            <code
              style={{
                background: "var(--bg-input)",
                padding: "0.5rem 1rem",
                borderRadius: "6px",
                fontSize: "0.85rem",
              }}
            >
              GET /api/admin/status (with ADMIN_AUTH_TOKEN header)
            </code>
          </div>
        </div>
      );
    }
  }

  // Derive everything from the registry — single source of truth
  const registry = resolveRegistry();
  const config = getInstanceConfig();
  const logs = getRecentLogs(10);

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";
  const enabledPacks = registry.filter((p) => p.enabled);
  const disabledPacks = registry.filter((p) => !p.enabled);
  const totalTools = enabledPacks.reduce((sum, p) => sum + p.manifest.tools.length, 0);

  return (
    <div className="container">
      {/* Header */}
      <header className="header">
        <div>
          <h1 className="header-title">MyMCP</h1>
          <p className="header-subtitle">Personal MCP Server — {config.displayName}</p>
        </div>
        <div className="header-badges">
          <span className="badge badge-green">
            <span className="status-dot live" />
            Live
          </span>
          <span className="badge badge-blue">{totalTools} tools</span>
          <span className="badge badge-purple">v1.0.0</span>
        </div>
      </header>

      {/* Stats */}
      <div className="stats-bar">
        <div className="stat-card">
          <span className="stat-value" style={{ color: "var(--accent)" }}>
            {totalTools}
          </span>
          <span className="stat-label">Active Tools</span>
        </div>
        <div className="stat-card">
          <span className="stat-value" style={{ color: "var(--green)" }}>
            {enabledPacks.length}
          </span>
          <span className="stat-label">Active Packs</span>
        </div>
        <div className="stat-card">
          <span className="stat-value" style={{ color: "var(--text-dim)" }}>
            {disabledPacks.length}
          </span>
          <span className="stat-label">Inactive Packs</span>
        </div>
        <div className="stat-card">
          <span className="stat-value" style={{ color: "var(--yellow)" }}>
            {config.timezone}
          </span>
          <span className="stat-label">Timezone</span>
        </div>
      </div>

      {/* Packs */}
      <section className="section">
        <h2 className="section-title">Tool Packs</h2>
        {registry.map((pack) => (
          <div key={pack.manifest.id} className="tool-card">
            <div className="tool-header">
              <span className="tool-name">{pack.manifest.label}</span>
              <span className={`badge ${pack.enabled ? "badge-green" : "badge-dim"}`}>
                {pack.enabled ? "Active" : "Inactive"}
              </span>
              <span className="badge badge-blue">{pack.manifest.tools.length} tools</span>
            </div>
            <p className="tool-desc">
              {pack.enabled
                ? pack.manifest.description
                : `${pack.manifest.description} — ${pack.reason}`}
            </p>
            {pack.enabled && (
              <div className="usecase-tags">
                {pack.manifest.tools.map((t) => (
                  <span key={t.name} className="tool-tag">
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>

      {/* MCP Connection — Claude Desktop + Claude Code configs */}
      <section className="section">
        <h2 className="section-title">Connect</h2>

        <ConfigBlock
          title="Claude Desktop"
          subtitle="Add to claude_desktop_config.json"
          config={JSON.stringify(
            {
              mcpServers: {
                mymcp: {
                  url: `${baseUrl}/api/mcp`,
                  headers: { Authorization: "Bearer <MCP_AUTH_TOKEN>" },
                },
              },
            },
            null,
            2
          )}
        />

        <div style={{ height: "1rem" }} />

        <ConfigBlock
          title="Claude Code"
          subtitle="Add to ~/.claude/settings.json"
          config={JSON.stringify(
            {
              mcpServers: {
                mymcp: {
                  type: "http",
                  url: `${baseUrl}/api/mcp`,
                  headers: { Authorization: "Bearer <MCP_AUTH_TOKEN>" },
                },
              },
            },
            null,
            2
          )}
        />

        <div style={{ marginTop: "1rem" }}>
          <a href="/setup" style={{ color: "var(--accent)", fontSize: "0.9rem" }}>
            Need to configure packs? Go to Setup →
          </a>
        </div>
      </section>

      {/* Recent Logs (ephemeral) */}
      {logs.length > 0 && (
        <section className="section">
          <h2 className="section-title">
            Recent Logs{" "}
            <span
              style={{
                fontSize: "0.7rem",
                color: "var(--text-muted)",
                fontWeight: 400,
                textTransform: "none",
              }}
            >
              (ephemeral — resets on cold start)
            </span>
          </h2>
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "1rem 1.5rem",
            }}
          >
            {logs.map((log, i) => (
              <div key={i} className="changelog-item">
                <span
                  className="changelog-version"
                  style={{
                    color: log.status === "success" ? "var(--green)" : "var(--red)",
                    minWidth: "140px",
                  }}
                >
                  {log.tool}
                </span>
                <span className="changelog-desc">
                  {log.status === "success" ? "OK" : log.error} — {log.durationMs}ms
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="footer">
        <a href="/playground" style={{ color: "var(--accent)", textDecoration: "none" }}>
          Tool Playground
        </a>
        {" · "}
        <a href="/setup" style={{ color: "var(--accent)", textDecoration: "none" }}>
          Setup
        </a>
        {" · "}
        <a href="/packs" style={{ color: "var(--accent)", textDecoration: "none" }}>
          Packs
        </a>
        {" · "}
        MyMCP v1.0.0
      </footer>
    </div>
  );
}
