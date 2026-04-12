"use client";

import { useState } from "react";
import type { ToolLog } from "@/core/logging";
import type { InstanceConfig } from "@/core/types";
import { OverviewTab } from "./tabs/overview";
import { PacksTab } from "./tabs/packs";
import { ToolsTab } from "./tabs/tools";
import { SkillsTab } from "./tabs/skills";
import { LogsTab } from "./tabs/logs";
import { SettingsTab } from "./tabs/settings";

export interface PackSummary {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  reason: string;
  toolCount: number;
  requiredEnvVars: string[];
  guide?: string;
  tools: { name: string; description: string; deprecated?: string }[];
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "packs", label: "Packs" },
  { id: "tools", label: "Tools" },
  { id: "skills", label: "Skills" },
  { id: "logs", label: "Logs" },
  { id: "settings", label: "Settings" },
];

export function ConfigTabs({
  activeTab,
  packs,
  totalTools,
  enabledCount,
  logs,
  baseUrl,
  config,
}: {
  activeTab: string;
  packs: PackSummary[];
  totalTools: number;
  enabledCount: number;
  logs: ToolLog[];
  baseUrl: string;
  config: InstanceConfig;
}) {
  const [tab, setTab] = useState(activeTab);

  const changeTab = (id: string) => {
    setTab(id);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", id);
    window.history.replaceState({}, "", url.toString());
  };

  return (
    <div>
      {/* Tab bar */}
      <div className="border-b border-border mb-6">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => changeTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                tab === t.id
                  ? "border-accent text-accent"
                  : "border-transparent text-text-dim hover:text-text hover:border-border-light"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {tab === "overview" && (
        <OverviewTab
          baseUrl={baseUrl}
          totalTools={totalTools}
          enabledCount={enabledCount}
          packCount={packs.length}
          logs={logs}
          config={config}
        />
      )}
      {tab === "packs" && <PacksTab packs={packs} />}
      {tab === "tools" && <ToolsTab packs={packs} />}
      {tab === "skills" && <SkillsTab />}
      {tab === "logs" && <LogsTab initialLogs={logs} />}
      {tab === "settings" && <SettingsTab config={config} />}
    </div>
  );
}
