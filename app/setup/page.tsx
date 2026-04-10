import { resolveRegistry } from "@/core/registry";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const registry = resolveRegistry();

  const packs = registry.map((p) => ({
    id: p.manifest.id,
    label: p.manifest.label,
    description: p.manifest.description,
    enabled: p.enabled,
    reason: p.reason,
    requiredEnvVars: p.manifest.requiredEnvVars,
  }));

  const googlePack = packs.find((p) => p.id === "google");
  const vaultPack = packs.find((p) => p.id === "vault");
  const browserPack = packs.find((p) => p.id === "browser");

  const configurable = packs.filter((p) => p.requiredEnvVars.length > 0);
  const configured = configurable.filter((p) => p.enabled);
  const progress =
    configurable.length > 0 ? Math.round((configured.length / configurable.length) * 100) : 100;

  return (
    <div className="container">
      <header className="header">
        <div>
          <h1 className="header-title">MyMCP Setup</h1>
          <p className="header-subtitle">Configure your personal MCP server</p>
        </div>
        <div className="header-badges">
          <span className={`badge ${progress === 100 ? "badge-green" : "badge-yellow"}`}>
            {configured.length}/{configurable.length} packs configured
          </span>
        </div>
      </header>

      {/* Progress bar */}
      <div style={{ marginBottom: "2rem" }}>
        <div
          style={{
            background: "var(--bg-input)",
            borderRadius: "6px",
            height: "8px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: progress === 100 ? "var(--green)" : "var(--accent)",
              height: "100%",
              width: `${progress}%`,
              transition: "width 0.3s",
              borderRadius: "6px",
            }}
          />
        </div>
      </div>

      {/* Google Workspace */}
      <section className="section">
        <div className="tool-card">
          <div className="tool-header">
            <span className="tool-name">Google Workspace</span>
            <span className={`badge ${googlePack?.enabled ? "badge-green" : "badge-dim"}`}>
              {googlePack?.enabled ? "Configured" : "Not configured"}
            </span>
          </div>
          <p className="tool-desc">Gmail, Calendar, Contacts, Drive — 18 tools</p>

          {!googlePack?.enabled && (
            <div
              style={{
                background: "var(--bg-input)",
                borderRadius: "var(--radius-sm)",
                padding: "1.25rem",
                marginTop: "1rem",
              }}
            >
              <p style={{ color: "var(--text-dim)", fontSize: "0.9rem", lineHeight: 1.8 }}>
                <strong style={{ color: "var(--text)" }}>Step 1:</strong> Create a Google Cloud
                OAuth app
                <br />
                Go to{" "}
                <a
                  href="https://console.cloud.google.com/apis/credentials"
                  target="_blank"
                  rel="noopener"
                  style={{ color: "var(--accent)" }}
                >
                  Google Cloud Console → APIs & Services → Credentials
                </a>
                <br />
                Create an OAuth 2.0 Client ID (Web application type)
                <br />
                Add callback URL:{" "}
                <code
                  style={{
                    background: "var(--bg-card)",
                    padding: "2px 6px",
                    borderRadius: "3px",
                    fontSize: "0.82rem",
                  }}
                >
                  {process.env.VERCEL_URL
                    ? `https://${process.env.VERCEL_URL}`
                    : "http://localhost:3000"}
                  /api/auth/google/callback
                </code>
                <br />
                <br />
                <strong style={{ color: "var(--text)" }}>Step 2:</strong> Set GOOGLE_CLIENT_ID and
                GOOGLE_CLIENT_SECRET in Vercel env vars
                <br />
                <br />
                <strong style={{ color: "var(--text)" }}>Step 3:</strong> Click the button below to
                connect your Google account
                <br />
              </p>
              {process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? (
                <a
                  href="/api/auth/google"
                  style={{
                    display: "inline-block",
                    marginTop: "1rem",
                    background: "var(--accent)",
                    color: "white",
                    padding: "0.6rem 1.5rem",
                    borderRadius: "8px",
                    textDecoration: "none",
                    fontWeight: 600,
                    fontSize: "0.9rem",
                  }}
                >
                  Connect Google Account
                </a>
              ) : (
                <p style={{ color: "var(--yellow)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
                  Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first, then redeploy.
                </p>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Vault */}
      <section className="section">
        <div className="tool-card">
          <div className="tool-header">
            <span className="tool-name">Obsidian Vault</span>
            <span className={`badge ${vaultPack?.enabled ? "badge-green" : "badge-dim"}`}>
              {vaultPack?.enabled ? "Configured" : "Not configured"}
            </span>
          </div>
          <p className="tool-desc">15 vault tools — read, write, search, backlinks, and more</p>

          {!vaultPack?.enabled && (
            <div
              style={{
                background: "var(--bg-input)",
                borderRadius: "var(--radius-sm)",
                padding: "1.25rem",
                marginTop: "1rem",
              }}
            >
              <p style={{ color: "var(--text-dim)", fontSize: "0.9rem", lineHeight: 1.8 }}>
                <strong style={{ color: "var(--text)" }}>Step 1:</strong> Create a GitHub repo for
                your Obsidian vault
                <br />
                <strong style={{ color: "var(--text)" }}>Step 2:</strong> Generate a{" "}
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noopener"
                  style={{ color: "var(--accent)" }}
                >
                  GitHub Personal Access Token
                </a>{" "}
                with{" "}
                <code
                  style={{ background: "var(--bg-card)", padding: "2px 6px", borderRadius: "3px" }}
                >
                  repo
                </code>{" "}
                scope
                <br />
                <strong style={{ color: "var(--text)" }}>Step 3:</strong> Set these env vars in
                Vercel:
                <br />
                <code
                  style={{ background: "var(--bg-card)", padding: "2px 6px", borderRadius: "3px" }}
                >
                  GITHUB_PAT
                </code>{" "}
                and{" "}
                <code
                  style={{ background: "var(--bg-card)", padding: "2px 6px", borderRadius: "3px" }}
                >
                  GITHUB_REPO
                </code>{" "}
                (format: owner/repo)
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Browser */}
      <section className="section">
        <div className="tool-card">
          <div className="tool-header">
            <span className="tool-name">Browser Automation</span>
            <span className={`badge ${browserPack?.enabled ? "badge-green" : "badge-dim"}`}>
              {browserPack?.enabled ? "Configured" : "Not configured"}
            </span>
          </div>
          <p className="tool-desc">4 tools — web browse, extract, act, LinkedIn feed</p>

          {!browserPack?.enabled && (
            <div
              style={{
                background: "var(--bg-input)",
                borderRadius: "var(--radius-sm)",
                padding: "1.25rem",
                marginTop: "1rem",
              }}
            >
              <p style={{ color: "var(--text-dim)", fontSize: "0.9rem", lineHeight: 1.8 }}>
                <strong style={{ color: "var(--text)" }}>Step 1:</strong> Create a{" "}
                <a
                  href="https://browserbase.com"
                  target="_blank"
                  rel="noopener"
                  style={{ color: "var(--accent)" }}
                >
                  Browserbase
                </a>{" "}
                account (free tier: 1h/month)
                <br />
                <strong style={{ color: "var(--text)" }}>Step 2:</strong> Create an{" "}
                <a
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noopener"
                  style={{ color: "var(--accent)" }}
                >
                  OpenRouter
                </a>{" "}
                API key (for AI-powered browser actions)
                <br />
                <strong style={{ color: "var(--text)" }}>Step 3:</strong> Set these env vars in
                Vercel:
                <br />
                <code
                  style={{ background: "var(--bg-card)", padding: "2px 6px", borderRadius: "3px" }}
                >
                  BROWSERBASE_API_KEY
                </code>
                ,{" "}
                <code
                  style={{ background: "var(--bg-card)", padding: "2px 6px", borderRadius: "3px" }}
                >
                  BROWSERBASE_PROJECT_ID
                </code>
                ,{" "}
                <code
                  style={{ background: "var(--bg-card)", padding: "2px 6px", borderRadius: "3px" }}
                >
                  OPENROUTER_API_KEY
                </code>
              </p>
            </div>
          )}
        </div>
      </section>

      <footer className="footer">
        <a href="/" style={{ color: "var(--accent)", textDecoration: "none" }}>
          Back to Dashboard
        </a>
      </footer>
    </div>
  );
}
