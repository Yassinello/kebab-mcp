"use client";

import { useState } from "react";

// ── Types ───────────────────────────────────────────────────────────

export interface ConnectorVar {
  key: string;
  label: string;
  help?: string;
  helpUrl?: string;
  placeholder?: string;
  sensitive?: boolean;
  optional?: boolean;
}

export interface ConnectorDef {
  id: string;
  name: string;
  description: string;
  toolCount: number;
  icon: string;
  starter?: boolean;
  recommended?: boolean;
  setupGuide: string[];
  vars: ConnectorVar[];
}

// ── Pack definitions ────────────────────────────────────────────────
// Extracted from the former app/setup/wizard.tsx so they can be shared
// by the Connectors tab without depending on the deleted setup page.

export const PACKS: ConnectorDef[] = [
  {
    id: "vault",
    name: "Obsidian Vault",
    description: "Notes, search, backlinks, web clipper",
    toolCount: 14,
    icon: "V",
    starter: true,
    recommended: true,
    setupGuide: [
      "Push your Obsidian vault to a GitHub repository",
      "Generate a Personal Access Token with 'repo' scope",
      "Enter the repo in owner/repo format (or paste the GitHub URL)",
    ],
    vars: [
      {
        key: "GITHUB_PAT",
        label: "GitHub Personal Access Token",
        helpUrl: "https://github.com/settings/tokens",
        help: "Needs 'repo' scope to read/write vault files.",
        placeholder: "ghp_...",
        sensitive: true,
      },
      {
        key: "GITHUB_REPO",
        label: "GitHub Repository",
        help: "You can paste the full URL — it will be converted automatically.",
        placeholder: "yourname/your-vault",
      },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Channels, messages, threads, search",
    toolCount: 6,
    icon: "S",
    starter: true,
    setupGuide: [
      "Create a Slack App at api.slack.com/apps",
      "Add Bot Token Scopes: channels:history, channels:read, chat:write, search:read",
      "Install the app to your workspace",
      "Copy the Bot User OAuth Token below",
    ],
    vars: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "Bot User OAuth Token",
        helpUrl: "https://api.slack.com/apps",
        help: "Starts with xoxb-",
        placeholder: "xoxb-...",
        sensitive: true,
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read, create, update, query databases",
    toolCount: 5,
    icon: "N",
    starter: true,
    setupGuide: [
      "Create an Internal Integration at notion.so/my-integrations",
      "Share your target pages/databases with the integration",
      "Copy the Internal Integration Token below",
    ],
    vars: [
      {
        key: "NOTION_API_KEY",
        label: "Internal Integration Token",
        helpUrl: "https://www.notion.so/my-integrations",
        help: "Starts with ntn_ or secret_",
        placeholder: "ntn_...",
        sensitive: true,
      },
    ],
  },
  {
    id: "google",
    name: "Google Workspace",
    description: "Gmail, Calendar, Contacts, Drive",
    toolCount: 18,
    icon: "G",
    setupGuide: [
      "Go to Google Cloud Console → APIs & Credentials",
      "Create an OAuth 2.0 Client (Web application type)",
      "Add your callback URL in Authorized redirect URIs",
      "Copy the Client ID and Client Secret below",
    ],
    vars: [
      {
        key: "GOOGLE_CLIENT_ID",
        label: "OAuth Client ID",
        helpUrl: "https://console.cloud.google.com/apis/credentials",
        placeholder: "123456789-abc.apps.googleusercontent.com",
      },
      {
        key: "GOOGLE_CLIENT_SECRET",
        label: "OAuth Client Secret",
        placeholder: "GOCSPX-...",
        sensitive: true,
      },
      {
        key: "GOOGLE_REFRESH_TOKEN",
        label: "OAuth Refresh Token",
        help: "You can generate this after deploy via the /api/auth/google flow.",
        placeholder: "1//...",
        sensitive: true,
        optional: true,
      },
    ],
  },
  {
    id: "browser",
    name: "Browser Automation",
    description: "Web browse, extract, act, observe, agent, link extraction, LinkedIn feed",
    toolCount: 7,
    icon: "B",
    setupGuide: [
      "Create a Browserbase account for cloud browser sessions",
      "Create an OpenRouter account for AI-powered extraction",
      "Copy your API keys and project ID below",
    ],
    vars: [
      {
        key: "BROWSERBASE_API_KEY",
        label: "Browserbase API Key",
        helpUrl: "https://browserbase.com",
        placeholder: "bb_live_...",
        sensitive: true,
      },
      {
        key: "BROWSERBASE_PROJECT_ID",
        label: "Browserbase Project ID",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      {
        key: "OPENROUTER_API_KEY",
        label: "OpenRouter API Key",
        helpUrl: "https://openrouter.ai/keys",
        placeholder: "sk-or-v1-...",
        sensitive: true,
      },
      {
        key: "BROWSERBASE_CONTEXT_LINKEDIN",
        label: "LinkedIn Context ID",
        help: "Persistent Browserbase context that holds your LinkedIn session cookies. Auto-filled by the 'Connect LinkedIn' button below.",
        placeholder: "auto-created on first connect",
        optional: true,
      },
    ],
  },
  {
    id: "paywall",
    name: "Paywall Readers",
    description: "Read paywalled Medium & Substack articles via your session cookies",
    toolCount: 1,
    icon: "P",
    setupGuide: [
      "Open Medium or Substack in Chrome, logged in",
      "DevTools → Application → Cookies → copy the session cookie value",
      "Paste it below — you only need to configure the sources you use",
    ],
    vars: [
      {
        key: "MEDIUM_SID",
        label: "Medium session cookie (sid)",
        help: "From medium.com cookies. Lasts ~1 year.",
        placeholder: "1:xxxxxxxx...",
        sensitive: true,
        optional: true,
      },
      {
        key: "SUBSTACK_SID",
        label: "Substack session cookie (substack.sid)",
        help: "From any *.substack.com cookies. Lasts ~30 days.",
        placeholder: "s%3Axxxxx...",
        sensitive: true,
        optional: true,
      },
    ],
  },
  {
    id: "apify",
    name: "Apify",
    description: "LinkedIn scrapers + any Apify actor on demand",
    toolCount: 10,
    icon: "A",
    setupGuide: [
      "Create an Apify account at apify.com",
      "Go to Settings → Integrations to copy your personal API token",
      "Optionally set APIFY_ACTORS to limit which LinkedIn wrappers load",
    ],
    vars: [
      {
        key: "APIFY_TOKEN",
        label: "Apify API Token",
        helpUrl: "https://console.apify.com/account/integrations",
        help: "Personal API token from your Apify account.",
        placeholder: "apify_api_...",
        sensitive: true,
      },
      {
        key: "APIFY_ACTORS",
        label: "Actor allowlist (comma-separated IDs)",
        help: "Optional. If set, only these actor IDs load as wrappers. Leave empty to enable all 6.",
        placeholder: "harvestapi/linkedin-company,harvestapi/linkedin-profile-scraper",
        optional: true,
      },
    ],
  },
  {
    id: "composio",
    name: "Composio",
    description: "1000+ app integrations (Jira, HubSpot, Salesforce...)",
    toolCount: 2,
    icon: "C",
    setupGuide: [
      "Create a Composio account at composio.dev",
      "Go to Settings to find your API key",
      "Connect your apps in the Composio dashboard",
    ],
    vars: [
      {
        key: "COMPOSIO_API_KEY",
        label: "API Key",
        helpUrl: "https://composio.dev",
        placeholder: "ck_...",
        sensitive: true,
      },
    ],
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

export function normalizeGitHubRepo(value: string): string {
  const cleaned = value.trim().replace(/\/+$/, "");
  const match = cleaned.match(/github\.com\/([^/]+\/[^/]+)/);
  return match?.[1] ?? cleaned;
}

export function cleanCredential(value: string): string {
  return value.trim().replace(/^[A-Z_]+=/, "");
}

// ── Icons ───────────────────────────────────────────────────────────

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {open ? (
        <>
          <path d="m15 18-.722-3.25M2 8a10.645 10.645 0 0 0 20 0M20 15l-1.726-2.05M4 15l1.726-2.05M9 18l.722-3.25" />
        </>
      ) : (
        <>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

// ── Credential Input ────────────────────────────────────────────────

export function CredentialInput({
  v,
  value,
  onChange,
}: {
  v: ConnectorVar;
  value: string;
  onChange: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const filled = value.length > 0;

  return (
    <div className="relative">
      <input
        type={v.sensitive && !revealed ? "password" : "text"}
        placeholder={v.placeholder || v.key}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full bg-bg-muted border rounded-md pl-3 pr-20 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 transition-colors ${
          filled ? "border-green/40 bg-green-bg/30" : "border-border focus:border-accent"
        }`}
      />
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
        {filled && (
          <span className="text-green flex items-center pr-1">
            <CheckIcon size={14} />
          </span>
        )}
        {v.sensitive && filled && (
          <button
            type="button"
            onClick={() => setRevealed(!revealed)}
            className="text-text-muted hover:text-text p-1 rounded"
            title={revealed ? "Hide value" : "Show value"}
          >
            <EyeIcon open={revealed} />
          </button>
        )}
      </div>
    </div>
  );
}
