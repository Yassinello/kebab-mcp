"use client";

import type { ToolLog } from "@/core/logging";
import type { InstanceConfig } from "@/core/types";
import { TabErrorBoundary } from "./error-boundary";
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
  tenantId,
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
  tenantId?: string | null;
}) {
  let tab: React.ReactNode;
  let section: string;

  switch (activeTab) {
    case "connectors":
      section = "Connectors";
      tab = <ConnectorsTab connectors={connectors} />;
      break;
    case "tools":
      section = "Tools";
      tab = <ToolsTab connectors={connectors} />;
      break;
    case "skills":
      section = "Skills";
      tab = <SkillsTab />;
      break;
    case "logs":
      section = "Logs";
      tab = <LogsTab initialLogs={logs} />;
      break;
    case "documentation":
      section = "Documentation";
      tab = <DocumentationTab docs={docs} />;
      break;
    case "settings":
      section = "Settings";
      tab = (
        <SettingsTab
          config={config}
          vaultEnabled={vaultEnabled}
          baseUrl={baseUrl}
          hasAuthToken={hasAuthToken}
        />
      );
      break;
    case "overview":
    default:
      section = "Overview";
      tab = (
        <OverviewTab
          baseUrl={baseUrl}
          totalTools={totalTools}
          enabledCount={enabledCount}
          connectorCount={connectors.length}
          logs={logs}
          config={config}
          version={version}
          commitSha={commitSha}
          tenantId={tenantId}
        />
      );
      break;
  }

  return <TabErrorBoundary section={section}>{tab}</TabErrorBoundary>;
}
