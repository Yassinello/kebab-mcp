"use client";

import { useState } from "react";
import type { InstanceConfig } from "@/core/types";
import { ContextFileField } from "./settings/context-file-field";
import { McpInstallPanel } from "./settings/mcp-install-panel";
import { InfoTooltip } from "./settings/info-tooltip";

const USER_FIELDS: {
  key: string;
  label: string;
  placeholder: string;
  help: string;
}[] = [
  {
    key: "MYMCP_DISPLAY_NAME",
    label: "Display Name",
    placeholder: "Your name",
    help: "Shown in the dashboard and tool greetings.",
  },
  {
    key: "MYMCP_TIMEZONE",
    label: "Timezone",
    placeholder: "Europe/Paris",
    help: "IANA format. Used to format dates in tool responses.",
  },
  {
    key: "MYMCP_LOCALE",
    label: "Locale",
    placeholder: "fr-FR",
    help: "Used to format numbers and currencies.",
  },
];

type SubTab = "user" | "mcp";

export function SettingsTab({
  config,
  vaultEnabled,
  baseUrl,
  hasAuthToken,
}: {
  config: InstanceConfig;
  vaultEnabled: boolean;
  baseUrl: string;
  hasAuthToken: boolean;
}) {
  const [tab, setTab] = useState<SubTab>("user");
  const [values, setValues] = useState<Record<string, string>>({
    MYMCP_DISPLAY_NAME: config.displayName,
    MYMCP_TIMEZONE: config.timezone,
    MYMCP_LOCALE: config.locale,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/config/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ vars: values }),
      });
      const data = await res.json();
      if (data.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError(data.error || "Save failed");
      }
    } catch {
      setError("Network error");
    }
    setSaving(false);
  };

  return (
    <div className="max-w-2xl">
      {/* Subtabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-border">
        {(
          [
            ["user", "User settings"],
            ["mcp", "MCP install"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`text-sm font-medium px-4 py-2 -mb-px border-b-2 transition-colors ${
              tab === k
                ? "border-accent text-accent"
                : "border-transparent text-text-dim hover:text-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "user" && (
        <>
          <div className="border border-border rounded-lg p-5 space-y-5">
            {USER_FIELDS.map((f) => (
              <div key={f.key}>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="text-sm font-medium">{f.label}</label>
                  <code className="text-[11px] text-text-muted">{f.key}</code>
                </div>
                <input
                  type="text"
                  placeholder={f.placeholder}
                  value={values[f.key] || ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
                <p className="text-xs text-text-muted mt-1">{f.help}</p>
              </div>
            ))}

            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-sm font-medium">Personal context</label>
                <InfoTooltip
                  title="What is the personal context file?"
                  body="A short markdown document that describes you (role, current projects, preferences). MCP clients can fetch it via the my_context tool to ground responses without you re-explaining everything every conversation. Two storage modes: store the markdown inline here (persists in the KV store), or point at a file inside your Obsidian vault if the Vault connector is active."
                />
              </div>
              <ContextFileField
                vaultEnabled={vaultEnabled}
                initialPath={config.contextPath}
              />
              <p className="text-xs text-text-muted mt-2">
                Pick where this context lives. Inline = stored in MyMCP&apos;s KV store. Vault = a
                file inside your Obsidian vault, fetched on demand.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving}
              className="bg-accent text-white text-sm font-medium px-5 py-2 rounded-md hover:bg-accent/90 disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save settings"}
            </button>
            {saved && <span className="text-xs text-green">Saved</span>}
            {error && <span className="text-xs text-red-500">{error}</span>}
          </div>
        </>
      )}

      {tab === "mcp" && (
        <McpInstallPanel baseUrl={baseUrl} hasToken={hasAuthToken} />
      )}
    </div>
  );
}
