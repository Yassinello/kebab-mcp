"use client";

import { PRODUCT } from "@/core/constants/brand";
import {
  claudeAddConnectorUrl,
  claudeCodeAddCommand,
  cursorInstallUrl,
  SETUP_PHRASE,
} from "@/core/client-links";
import { useState } from "react";

/**
 * Shared MCP install snippets used by both /welcome/TokenUsagePanel and
 * /config → Settings → MCP install.
 *
 * Consolidates the client tab / snippet generation / copy-button logic
 * that used to live in two separate components and was drifting (the
 * welcome version had a platform-specific desktop config path while the
 * settings version didn't; the settings version had a mask/reveal toggle
 * while the welcome version didn't).
 *
 * Two "variants" to accommodate the caller differences:
 * - `variant="plain"`: token is always visible, no reveal/mask. Used on
 *   /welcome right after the user mints the token for the first time.
 * - `variant="masked"`: token starts masked. Used on /config/settings,
 *   where the token is fetched on demand via /api/config/auth-token.
 */

type Client =
  | "claude-desktop-connector"
  | "claude-desktop-config"
  | "claude-code"
  | "cursor"
  | "other";

const CLIENT_LABELS: Record<Client, string> = {
  "claude-desktop-connector": "Claude (web, desktop)",
  "claude-desktop-config": "Claude Desktop · Config file",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  other: "Other",
};

export interface McpClientSnippetsProps {
  /** Base URL of the MCP server, e.g. https://mymcp-yass.vercel.app */
  baseUrl: string;
  /** The token to embed in snippets. Null when masked and not yet revealed. */
  token: string | null;
  /** Theme: welcome uses slate palette, dashboard uses the theme tokens. */
  theme?: "welcome" | "dashboard";
  /** Copy button label override */
  copyLabel?: string;
}

export function McpClientSnippets({
  baseUrl,
  token,
  theme = "dashboard",
  copyLabel = "Copy",
}: McpClientSnippetsProps) {
  const [client, setClient] = useState<Client>("claude-desktop-connector");
  const [copied, setCopied] = useState(false);

  const url = `${baseUrl}/api/mcp`;
  const tokenForSnippet = token ?? "<YOUR_TOKEN>";
  const urlWithToken = `${url}?token=${encodeURIComponent(tokenForSnippet)}`;

  const desktopConfigSnippet = JSON.stringify(
    {
      mcpServers: {
        "kebab-mcp": {
          url,
          headers: { Authorization: `Bearer ${tokenForSnippet}` },
        },
      },
    },
    null,
    2
  );

  // Kebab House phase 1: Claude Code negotiates OAuth on first use (no token in config).
  const claudeCodeSnippet = claudeCodeAddCommand(url);

  const cursorSnippet = JSON.stringify(
    {
      mcpServers: {
        "kebab-mcp": {
          url: urlWithToken,
        },
      },
    },
    null,
    2
  );

  const desktopPath =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
      ? "~/Library/Application Support/Claude/claude_desktop_config.json"
      : "%APPDATA%\\Claude\\claude_desktop_config.json";

  const snippet =
    client === "claude-desktop-connector"
      ? url
      : client === "claude-desktop-config"
        ? desktopConfigSnippet
        : client === "claude-code"
          ? claudeCodeSnippet
          : client === "cursor"
            ? cursorSnippet
            : urlWithToken;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  // Theme-dependent class sets.
  const t =
    theme === "welcome"
      ? {
          tabBarBg: "bg-slate-950",
          tabBarBorder: "border-slate-800",
          tabActive: "bg-slate-800 text-white",
          tabInactive: "text-slate-500 hover:text-slate-300",
          helpText: "text-slate-500",
          codeColor: "text-slate-400",
          preBg: "bg-slate-950",
          preBorder: "border-slate-800",
          preText: "text-slate-300",
          copyBg: "bg-slate-800 hover:bg-slate-700",
          copyText: "text-slate-300",
          copiedBg: "bg-emerald-900/60",
          copiedText: "text-emerald-300",
          endpointText: "text-slate-500",
        }
      : {
          tabBarBg: "bg-bg-muted",
          tabBarBorder: "border-border",
          tabActive: "border-accent text-accent",
          tabInactive: "border-transparent text-text-dim hover:text-text",
          helpText: "text-text-muted",
          codeColor: "text-text-muted",
          preBg: "bg-bg-muted",
          preBorder: "border-border",
          preText: "text-text-dim",
          copyBg: "bg-bg hover:bg-bg-sidebar",
          copyText: "text-text",
          copiedBg: "bg-green-bg",
          copiedText: "text-green",
          endpointText: "text-text-muted",
        };

  return (
    <div>
      <div
        className={`flex items-center gap-1 flex-wrap mb-3 ${
          theme === "welcome"
            ? `rounded-md p-0.5 border ${t.tabBarBorder} ${t.tabBarBg}`
            : `border-b ${t.tabBarBorder}`
        }`}
      >
        {(Object.keys(CLIENT_LABELS) as Client[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setClient(c)}
            className={
              theme === "welcome"
                ? `text-[11px] font-medium px-2.5 py-1 rounded transition-colors ${
                    client === c ? t.tabActive : t.tabInactive
                  }`
                : `text-xs font-medium px-3 py-2 -mb-px border-b-2 transition-colors ${
                    client === c ? t.tabActive : t.tabInactive
                  }`
            }
          >
            {CLIENT_LABELS[c]}
          </button>
        ))}
      </div>

      <HelpText tab={client} theme={theme} desktopPath={desktopPath} baseUrl={url} />

      {client === "claude-desktop-connector" && (
        <a
          href={claudeAddConnectorUrl(url)}
          target="_blank"
          rel="noreferrer"
          className="inline-block mb-3 bg-accent text-white text-xs font-medium px-3 py-1.5 rounded-md hover:bg-accent/90"
        >
          Add to Claude
        </a>
      )}
      {client === "cursor" && (
        <a
          href={cursorInstallUrl(url)}
          className="inline-block mb-3 bg-accent text-white text-xs font-medium px-3 py-1.5 rounded-md hover:bg-accent/90"
        >
          Add to Cursor
        </a>
      )}

      <div className="relative">
        <pre
          className={`text-[11px] font-mono ${t.preBg} border ${t.preBorder} px-3 py-2.5 rounded-md ${t.preText} overflow-x-auto whitespace-pre-wrap break-all`}
        >
          {snippet}
        </pre>
        <button
          type="button"
          onClick={copy}
          className={`absolute top-2 right-2 text-[10px] font-medium px-2 py-1 rounded-md transition-colors ${
            copied ? `${t.copiedBg} ${t.copiedText}` : `${t.copyBg} ${t.copyText}`
          }`}
        >
          {copied ? "Copied!" : copyLabel}
        </button>
      </div>

      <p className={`text-[10px] ${t.endpointText} mt-3`}>
        Endpoint: <code className="font-mono">{url}</code>
      </p>
    </div>
  );
}

function HelpText({
  tab,
  theme,
  desktopPath,
  baseUrl,
}: {
  tab: Client;
  theme: "welcome" | "dashboard";
  desktopPath: string;
  baseUrl: string;
}) {
  const klass = `text-[11px] leading-relaxed mb-2 ${
    theme === "welcome" ? "text-slate-500" : "text-text-muted"
  }`;
  const codeKlass = `font-mono ${theme === "welcome" ? "text-slate-400" : "text-text-muted"}`;

  if (tab === "claude-desktop-connector") {
    return (
      <p className={klass}>
        Click <strong>Add to Claude</strong> (or in Claude:{" "}
        <strong>Customize → Connectors → Add custom connector</strong>, name{" "}
        <code className={codeKlass}>{PRODUCT.name}</code>, this URL). Claude then opens your Kebab
        House to ask for your approval — no token to paste. Once connected, say{" "}
        <em>&ldquo;{SETUP_PHRASE}&rdquo;</em> to start the guided setup.
      </p>
    );
  }

  if (tab === "claude-desktop-config") {
    return (
      <p className={klass}>
        Open <code className={codeKlass}>{desktopPath}</code> (create it if missing), paste the
        snippet below, then restart Claude Desktop.
      </p>
    );
  }

  if (tab === "claude-code") {
    return (
      <p className={klass}>
        Run this command in any terminal. Claude Code opens your browser once to approve the
        connection (OAuth); no token is stored in its config.
      </p>
    );
  }

  if (tab === "cursor") {
    return (
      <p className={klass}>
        Cursor → Settings → MCP. Add a server and paste this JSON, or edit{" "}
        <code className={codeKlass}>~/.cursor/mcp.json</code>.
      </p>
    );
  }

  return (
    <p className={klass}>
      For ChatGPT desktop, n8n, Continue, or any other MCP client: paste this URL (token embedded in
      the query string). Clients that support custom headers can use the base URL{" "}
      <code className={codeKlass}>{baseUrl}</code> with{" "}
      <code className={codeKlass}>Authorization: Bearer &lt;token&gt;</code>.
    </p>
  );
}
