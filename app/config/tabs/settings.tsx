"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UnderlineTabs } from "../../components/page-tabs";
import type { InstanceConfig } from "@/core/types";
import { McpInstallPanel } from "./settings/mcp-install-panel";
import { AdvancedSection } from "./settings/advanced-section";

/**
 * Plain labels for end users (C1.5); the environment variable behind each
 * field stays available as a hover hint for self-hosters.
 */
const USER_FIELDS: {
  key: string;
  label: string;
  placeholder: string;
  help: string;
}[] = [
  {
    key: "MYMCP_DISPLAY_NAME",
    label: "Your name",
    placeholder: "Your name",
    help: "Shown in the dashboard and in greetings from your AI clients.",
  },
  {
    key: "MYMCP_TIMEZONE",
    label: "Time zone",
    placeholder: "Europe/Paris",
    help: "Used to show dates and times in your time zone (for example Europe/Paris).",
  },
  {
    key: "MYMCP_LOCALE",
    label: "Language and region",
    placeholder: "fr-FR",
    help: "Used to format numbers and currencies (for example fr-FR or en-US).",
  },
];

type SubTab = "user" | "mcp" | "advanced";

export function SettingsTab({
  config,
  baseUrl,
  hasAuthToken,
  scopeBadge,
}: {
  config: InstanceConfig;
  baseUrl: string;
  hasAuthToken: boolean;
  /**
   * Phase 48 / FACADE-04: identifies whether the operator is viewing
   * global settings (`null`) or a specific tenant's override.
   * Shown as a small read-only badge above the user-field list so the
   * operator understands where writes will land. No UX beyond the badge
   * — the write-direction itself is server-side (x-mymcp-tenant header).
   */
  scopeBadge?: { mode: "global" | "tenant"; tenantId?: string } | null;
}) {
  // Subtab state is reflected in the URL (?tab=settings&sub=user|mcp|advanced)
  // so deep-linking and back/forward navigation work. Default to "user".
  // The profile editors moved to the Profile page, Devices and Storage to
  // their own pages (C1.2 / C1.5; page.tsx redirects the old sub-tab links).
  const searchParams = useSearchParams();
  const router = useRouter();
  const subFromUrl = searchParams.get("sub");
  const initialSub: SubTab =
    subFromUrl === "mcp" ? "mcp" : subFromUrl === "advanced" ? "advanced" : "user";
  const [tab, setTabState] = useState<SubTab>(initialSub);
  const setTab = (next: SubTab) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "settings");
    params.set("sub", next);
    router.replace(`/config?${params.toString()}`, { scroll: false });
  };
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
      {/* Subtabs — MOBILE-04: larger tap targets and horizontal scroll
          fallback if labels ever overflow on a narrow viewport. */}
      <UnderlineTabs
        label="Settings sections"
        idBase="settings"
        value={tab}
        onChange={setTab}
        tabs={
          [
            { id: "user", label: "User settings" },
            { id: "mcp", label: "MCP install" },
            { id: "advanced", label: "Advanced" },
          ] as const
        }
      />

      {tab === "user" && (
        <>
          {scopeBadge && (
            <div className="mb-3 flex items-center gap-2 text-xs">
              <span className="text-text-dim">Scope:</span>
              {scopeBadge.mode === "global" ? (
                <span className="font-mono bg-bg-muted border border-border rounded px-2 py-0.5">
                  Global (root)
                </span>
              ) : (
                <span className="font-mono bg-bg-muted border border-border rounded px-2 py-0.5">
                  Tenant {scopeBadge.tenantId ?? "?"} (override)
                </span>
              )}
            </div>
          )}
          <div className="border border-border rounded-lg p-5 space-y-5">
            {USER_FIELDS.map((f) => (
              <div key={f.key}>
                <label
                  htmlFor={`setting-${f.key}`}
                  className="text-sm font-medium block mb-1.5"
                  title={`Environment variable: ${f.key}`}
                >
                  {f.label}
                </label>
                <input
                  id={`setting-${f.key}`}
                  type="text"
                  placeholder={f.placeholder}
                  value={values[f.key] || ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
                <p className="text-xs text-text-muted mt-1">{f.help}</p>
              </div>
            ))}
            <p className="text-xs text-text-muted border-t border-border pt-4">
              Your profile, the notes your AI clients keep and your backups now live on the{" "}
              <a href="/config?tab=profile" className="text-accent hover:underline">
                Profile
              </a>{" "}
              and{" "}
              <a href="/config?tab=memory" className="text-accent hover:underline">
                Memory
              </a>{" "}
              pages.
            </p>
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
            {error && <span className="text-xs text-red">{error}</span>}
          </div>
        </>
      )}

      {tab === "mcp" && <McpInstallPanel baseUrl={baseUrl} hasToken={hasAuthToken} />}

      {tab === "advanced" && <AdvancedSection />}
    </div>
  );
}
