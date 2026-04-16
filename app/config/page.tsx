import { AppShell } from "../sidebar";
import { getInstanceConfigAsync } from "@/core/config";
import { resolveRegistry } from "@/core/registry";
import { getRecentLogs } from "@/core/logging";
import { isFirstRunMode } from "@/core/first-run";
import { loadDocs } from "@/core/docs";
import { ConfigTabs } from "./tabs";
import { DryRunBanner } from "./dry-run-banner";
import { cookies } from "next/headers";
import packageJson from "../../package.json";

export const dynamic = "force-dynamic";

const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  overview: { title: "Overview", subtitle: "Live status of your MCP server." },
  connectors: { title: "Connectors", subtitle: "Enable, configure, and test your connectors." },
  tools: { title: "Tools", subtitle: "Browse and run any registered tool." },
  skills: { title: "Skills", subtitle: "Create and manage user-defined skills." },
  playground: { title: "Playground", subtitle: "Try tools interactively." },
  logs: { title: "Logs", subtitle: "Recent tool invocations." },
  documentation: { title: "Documentation", subtitle: "Guides and reference for MyMCP." },
  settings: { title: "Settings", subtitle: "Server-wide configuration." },
};

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; tenant?: string }>;
}) {
  const params = await searchParams;
  const tab = params.tab || "overview";
  const meta = PAGE_META[tab] || PAGE_META.overview;
  const config = await getInstanceConfigAsync();

  // Tenant scoping: read from cookie (set by admin) or query param
  const cookieStore = await cookies();
  const tenantId = cookieStore.get("mymcp-tenant")?.value || params.tenant || null;

  const registry = resolveRegistry();
  const logs = getRecentLogs(100);

  const enabled = registry.filter((p) => p.enabled);
  const totalTools = enabled.reduce((s, p) => s + p.manifest.tools.length, 0);

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const connectorSummaries = registry.map((p) => ({
    id: p.manifest.id,
    label: p.manifest.label,
    description: p.manifest.description,
    enabled: p.enabled,
    reason: p.reason,
    toolCount: p.manifest.tools.length,
    requiredEnvVars: p.manifest.requiredEnvVars,
    guide: p.manifest.guide,
    core: p.manifest.core,
    tools: p.manifest.tools.map((t) => ({
      name: t.name,
      description: t.description,
      deprecated: t.deprecated,
      destructive: t.destructive,
    })),
  }));

  // Dry-run mode: instance has no MCP_AUTH_TOKEN. The user reached this page
  // via the /welcome claim cookie (checkAdminAuth's isClaimer bypass) and is
  // exploring before minting a token.
  const dryRunMode = isFirstRunMode();

  const vaultEnabled = registry.some((p) => p.manifest.id === "vault" && p.enabled);
  // Documentation tab content is loaded lazily — only when the user
  // navigates there. Keeps cold-start cost off other tabs.
  const docs = tab === "documentation" ? loadDocs() : [];
  // Token presence is exposed (so the Reveal button knows what to show)
  // but the value itself is fetched on click via /api/config/auth-token,
  // never serialized into the page payload.
  const hasAuthToken = !!(process.env.MCP_AUTH_TOKEN || "").split(",")[0]?.trim();
  const version = packageJson.version;
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || undefined;

  return (
    <AppShell title={meta.title} subtitle={meta.subtitle} displayName={config.displayName}>
      {dryRunMode && <DryRunBanner />}
      <ConfigTabs
        activeTab={tab}
        connectors={connectorSummaries}
        totalTools={totalTools}
        enabledCount={enabled.length}
        logs={logs}
        baseUrl={baseUrl}
        config={config}
        docs={docs}
        vaultEnabled={vaultEnabled}
        hasAuthToken={hasAuthToken}
        version={version}
        commitSha={commitSha}
        tenantId={tenantId}
      />
    </AppShell>
  );
}
