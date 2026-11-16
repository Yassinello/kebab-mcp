"use client";

import dynamic from "next/dynamic";
import type { ToolLog } from "@/core/logging";
import type { InstanceConfig } from "@/core/types";
import { TabErrorBoundary } from "./error-boundary";

// PERF-02 (v0.11 Phase 43):
// Overview stays eager — it's the default landing. Any `next/dynamic`
// wrapper on Overview would force a network round-trip on first paint
// and defeats the zero-chunk-request promise for the default route.
import { OverviewTab } from "./tabs/overview";

// Type-only re-export for `DocEntry` lives on the eager side so page.tsx
// can still `import { type DocEntry } from "./tabs"` without pulling the
// runtime module into the tabs.tsx chunk.
import type { DocEntry } from "./tabs/documentation";

/**
 * Lightweight loading skeleton shown while a dynamic tab chunk fetches.
 * Intentionally minimal — goal is layout-shift prevention, not a
 * designed loading experience. Matches the Tailwind dashboard palette.
 */
function TabLoadingSkeleton({ label }: { label: string }) {
  return <div className="p-8 text-sm text-gray-500 dark:text-gray-400">Loading {label}…</div>;
}

// 9 lazy-loaded tabs. Each `dynamic(() => import("./tabs/<name>"))` call
// produces a dedicated chunk the Next runtime fetches on first
// navigation and caches for the session.
//
// `ssr: true` for tabs whose content is deterministic server-side (SEO
// + no-FOUC). `ssr: false` for tabs that poll / stream (Playground,
// Logs, Storage, Health) — SSRing a stale snapshot would mislead the
// user and defeat the point of those tabs.
const ConnectorsTab = dynamic(
  () => import("./tabs/connectors").then((m) => ({ default: m.ConnectorsTab })),
  { ssr: true, loading: () => <TabLoadingSkeleton label="Connectors" /> }
);
const ToolsTab = dynamic(() => import("./tabs/tools").then((m) => ({ default: m.ToolsTab })), {
  ssr: true,
  loading: () => <TabLoadingSkeleton label="Tools" />,
});
const SkillsTab = dynamic(() => import("./tabs/skills").then((m) => ({ default: m.SkillsTab })), {
  ssr: true,
  loading: () => <TabLoadingSkeleton label="Skills" />,
});
const PlaygroundTab = dynamic(
  () => import("./tabs/playground").then((m) => ({ default: m.PlaygroundTab })),
  // ssr: false — playground uses browser-only APIs (fetch loops, client state).
  { ssr: false, loading: () => <TabLoadingSkeleton label="Playground" /> }
);
const LogsTab = dynamic(
  () => import("./tabs/logs").then((m) => ({ default: m.LogsTab })),
  // ssr: false — logs are a live stream; SSRing a stale snapshot would confuse.
  { ssr: false, loading: () => <TabLoadingSkeleton label="Logs" /> }
);
const DocumentationTab = dynamic(
  () => import("./tabs/documentation").then((m) => ({ default: m.DocumentationTab })),
  { ssr: true, loading: () => <TabLoadingSkeleton label="Documentation" /> }
);
const SettingsTab = dynamic(
  () => import("./tabs/settings").then((m) => ({ default: m.SettingsTab })),
  { ssr: true, loading: () => <TabLoadingSkeleton label="Settings" /> }
);
// C1.2 / C1.3 / C1.5: the hub pages — Profile, Memory — and Devices /
// Storage, promoted back to top-level pages (main menu and Advanced).
const ProfileTab = dynamic(
  () => import("./tabs/profile").then((m) => ({ default: m.ProfileTab })),
  { ssr: true, loading: () => <TabLoadingSkeleton label="Profile" /> }
);
const MemoryTab = dynamic(
  () => import("./tabs/memory").then((m) => ({ default: m.MemoryTab })),
  // ssr: false — the page is driven by client-side browsing and search.
  { ssr: false, loading: () => <TabLoadingSkeleton label="Memory" /> }
);
const DevicesTab = dynamic(
  () => import("./tabs/devices").then((m) => ({ default: m.DevicesTab })),
  { ssr: true, loading: () => <TabLoadingSkeleton label="Devices" /> }
);
const StorageTab = dynamic(
  () => import("./tabs/storage").then((m) => ({ default: m.StorageTab })),
  { ssr: false, loading: () => <TabLoadingSkeleton label="Storage" /> }
);
const HealthTab = dynamic(
  () => import("./tabs/health").then((m) => ({ default: m.HealthTab })),
  // ssr: false — health polls /api/health on an interval.
  { ssr: false, loading: () => <TabLoadingSkeleton label="Health" /> }
);

// Re-export the DocEntry type for page.tsx. Keeping this under `export
// type` ensures Turbopack does NOT pull the runtime documentation tab
// module into the consumer's chunk.
export type { DocEntry };

export interface ConnectorSummary {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  reason: string;
  toolCount: number;
  requiredEnvVars: string[];
  guide?: string | undefined;
  core?: boolean | undefined;
  tools: {
    name: string;
    description: string;
    deprecated?: string | undefined;
    destructive: boolean;
  }[];
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
  disabledTools,
  tenantIds,
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
  commitSha?: string | undefined;
  tenantId?: string | null | undefined;
  /** Server-fetched disabled tool names — avoids client-side loading spinner. */
  disabledTools?: string[] | undefined;
  /** Phase 53: tenant IDs discovered from MCP_AUTH_TOKEN_* env vars. */
  tenantIds?: string[] | undefined;
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
      tab = <ToolsTab connectors={connectors} initialDisabledTools={disabledTools} />;
      break;
    case "skills":
      section = "Skills";
      tab = <SkillsTab />;
      break;
    // Custom Tools was demoted from a top-level tab to the Tools tab's
    // "custom" sub-tab. The legacy ?tab=custom-tools URL still resolves
    // here (bookmark compat) by forcing ToolsTab into the custom sub-tab.
    case "custom-tools":
      section = "Tools";
      tab = (
        <ToolsTab connectors={connectors} initialDisabledTools={disabledTools} forceSub="custom" />
      );
      break;
    case "playground":
      section = "Playground";
      tab = <PlaygroundTab />;
      break;
    case "logs":
      section = "Logs";
      // Phase 48 / ISO-02: tenant selector surfaces only when the admin
      // has no tenant header (root scope). A scoped admin sees only
      // their own buffer — privacy guard at the route layer, too.
      tab = <LogsTab initialLogs={logs} initialIsRootScope={!tenantId} />;
      break;
    case "documentation":
      section = "Documentation";
      tab = <DocumentationTab docs={docs} />;
      break;
    case "settings":
      section = "Settings";
      // Phase 48 / FACADE-04: scope badge — tenant-scoped admins see
      // their override namespace, root admins see the global config.
      tab = (
        <SettingsTab
          config={config}
          baseUrl={baseUrl}
          hasAuthToken={hasAuthToken}
          scopeBadge={tenantId ? { mode: "tenant", tenantId } : { mode: "global" }}
        />
      );
      break;
    // C1.5: Devices is a main-menu page and Storage an Advanced page again
    // (they were Settings sub-tabs; page.tsx redirects the old
    // ?tab=settings&sub=devices|storage links here).
    case "storage":
      section = "Storage";
      tab = <StorageTab />;
      break;
    case "devices":
      section = "Devices";
      tab = <DevicesTab tenantId={tenantId} baseUrl={baseUrl} connectors={connectors} />;
      break;
    case "profile":
      section = "Profile";
      tab = <ProfileTab vaultEnabled={vaultEnabled} initialPath={config.contextPath} />;
      break;
    case "memory":
      section = "Memory";
      tab = <MemoryTab />;
      break;
    case "health":
      section = "Health";
      // Phase 53: rootScope derived from tenantId cookie (Phase 48).
      // tenantIds list populated server-side from MCP_AUTH_TOKEN_*
      // env vars. Scoped admins get rootScope=false and no tenant list.
      tab = <HealthTab rootScope={tenantId == null} tenantIds={tenantIds ?? []} />;
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
          version={version}
          commitSha={commitSha}
          tenantId={tenantId}
        />
      );
      break;
  }

  return <TabErrorBoundary section={section}>{tab}</TabErrorBoundary>;
}
