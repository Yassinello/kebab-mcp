"use client";

import type { ToolLog } from "@/core/logging";
import type { InstanceConfig } from "@/core/types";
import { OverviewTab } from "./tabs/overview";
import { ConnectorsTab } from "./tabs/connectors";
import { ToolsTab } from "./tabs/tools";
import { SkillsTab } from "./tabs/skills";
import { LogsTab } from "./tabs/logs";
import { SettingsTab } from "./tabs/settings";
import { DocumentationTab, type DocEntry } from "./tabs/documentation";

export interface ConnectorSummary {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  reason: string;
  toolCount: number;
  requiredEnvVars: string[];
  guide?: string;
  core?: boolean;
  tools: { name: string; description: string; deprecated?: string; destructive: boolean }[];
}

export function ConfigTabs({
  activeTab,
  connectors,
  totalTools,
  enabledCount,
  logs,
  baseUrl,
  config,
  docs,
  vaultEnabled,
  hasAuthToken,
  version,
  commitSha,
}: {
  activeTab: string;
  connectors: ConnectorSummary[];
  totalTools: number;
  enabledCount: number;
  logs: ToolLog[];
  baseUrl: string;
  config: InstanceConfig;
  docs: DocEntry[];
  vaultEnabled: boolean;
  hasAuthToken: boolean;
  version: string;
  commitSha?: string;
}) {
  switch (activeTab) {
    case "connectors":
      return <ConnectorsTab connectors={connectors} />;
    case "tools":
      return <ToolsTab connectors={connectors} />;
    case "skills":
      return <SkillsTab />;
    case "logs":
      return <LogsTab initialLogs={logs} />;
    case "documentation":
      return <DocumentationTab docs={docs} />;
    case "settings":
      return (
        <SettingsTab
          config={config}
          vaultEnabled={vaultEnabled}
          baseUrl={baseUrl}
          hasAuthToken={hasAuthToken}
        />
      );
    case "overview":
    default:
      return (
        <OverviewTab
          baseUrl={baseUrl}
          totalTools={totalTools}
          enabledCount={enabledCount}
          connectorCount={connectors.length}
          logs={logs}
          config={config}
          version={version}
          commitSha={commitSha}
        />
      );
  }
}
