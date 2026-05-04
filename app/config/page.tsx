import { AppShell } from "../sidebar";
import { getInstanceConfigAsync } from "@/core/config";
import { resolveRegistryAsync } from "@/core/registry";
import { getRecentLogs } from "@/core/logging";
import { isFirstRunMode, rehydrateBootstrapAsync } from "@/core/first-run";
import { loadDocs } from "@/core/docs";
import { getDisabledTools } from "@/core/tool-toggles";
import { ConfigTabs } from "./tabs";
import { DryRunBanner } from "./dry-run-banner";
import { DestructiveVarsBanner } from "./banner";
import { cookies } from "next/headers";
import packageJson from "../../package.json";
import { getConfig } from "@/core/config-facade";

export const dynamic = "force-dynamic";

const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  overview: { title: "Overview", subtitle: "Live status of your MCP server." },
  connectors: { title: "Connectors", subtitle: "Enable, configure, and test your connectors." },
  tools: { title: "Tools", subtitle: "Browse and run any registered tool." },
  skills: { title: "Skills", subtitle: "Create and manage user-defined skills." },
  "custom-tools": {
    title: "Custom Tools",
    subtitle: "Compose existing tools into new MCP tools — declarative JSON, no code.",
  },
  playground: { title: "Playground", subtitle: "Try tools interactively." },
  logs: { title: "Logs", subtitle: "Recent tool invocations." },
  documentation: { title: "Documentation", subtitle: "Guides and reference for Kebab MCP." },
  storage: { title: "Storage", subtitle: "Where your credentials and skills live." },
  health: {
    title: "Health",
    subtitle: "Live instance diagnostics — bootstrap state, KV, rehydrate counters.",
  },
  devices: {
    title: "Devices",
    subtitle: "Manage per-client tokens: add, rename, rotate, revoke.",
  },
  settings: { title: "Settings", subtitle: "Server-wide configuration." },
};

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; tenant?: string }>;
}) {
  const params = await searchParams;
  const tab = params.tab || "overview";
  const meta = PAGE_META[tab] || PAGE_META.overview || { title: "Dashboard", subtitle: "" };
  const config = await getInstanceConfigAsync();

  // Tenant scoping: read from cookie (set by admin) or query param.
  // Validate that the tenant was deliberately configured (env var exists)
  // to prevent unauthenticated tenant impersonation.
  const cookieStore = await cookies();
  const rawTenantId = cookieStore.get("mymcp-tenant")?.value || params.tenant || null;
  const tenantId =
    rawTenantId && getConfig(`MCP_AUTH_TOKEN_${rawTenantId.toUpperCase()}`) ? rawTenantId : null;

  // PERF-01: lazy resolve. RSC frame is already async; cost-free to await.
  const registry = await resolveRegistryAsync();
  const logs = getRecentLogs(100);

  // Phase 53 / OBS-06: discover tenant IDs for the Health tab selector.
  // Convention (Phase 48): each tenant has its own MCP_AUTH_TOKEN_<UPPER>
  // env var. Suffix after `MCP_AUTH_TOKEN_` (lowercased) = tenantId.
  // Scoped admins pass an empty list — TenantSelector renders null for
  // them regardless.
  const tenantIds = Object.keys(process.env)
    .filter((k) => k.startsWith("MCP_AUTH_TOKEN_"))
    .map((k) => k.slice("MCP_AUTH_TOKEN_".length).toLowerCase())
    .filter((id) => id.length > 0)
    .sort();

  const enabled = registry.filter((p) => p.enabled);
  const totalTools = enabled.reduce((s, p) => s + p.manifest.tools.length, 0);

  const vercelUrl = getConfig("VERCEL_URL");
  const baseUrl = vercelUrl ? `https://${vercelUrl}` : "http://localhost:3000";

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
  //
  // Edge middleware (proxy.ts) rehydrates the Edge-side cache, but Server
  // Components run in Node, where bootstrapAuthTokenCache is separate. On a
  // cold Node lambda whose Edge sibling already warmed up, isFirstRunMode()
  // would falsely return true even though the token lives in Upstash KV.
  // Calling rehydrateBootstrapAsync() before the check pulls KV → Node-side
  // cache. The function is idempotent and short-circuits if KV is already
  // mirrored to module state, so warm lambdas pay zero cost.
  await rehydrateBootstrapAsync();
  const dryRunMode = isFirstRunMode();

  const vaultEnabled = registry.some((p) => p.manifest.id === "vault" && p.enabled);
  // Documentation tab content is loaded lazily — only when the user
  // navigates there. Keeps cold-start cost off other tabs.
  const docs = tab === "documentation" ? loadDocs() : [];
  // Token presence is exposed (so the Reveal button knows what to show)
  // but the value itself is fetched on click via /api/config/auth-token,
  // never serialized into the page payload.
  const hasAuthToken = !!(getConfig("MCP_AUTH_TOKEN") || "").split(",")[0]?.trim();
  const version = packageJson.version;
  const commitSha = getConfig("VERCEL_GIT_COMMIT_SHA")?.slice(0, 8) || undefined;

  // RSC-01: Fetch disabled tools server-side so the Tools tab renders
  // instantly without a loading spinner / client-side fetch.
  const disabledToolsSet = await getDisabledTools();
  const disabledTools = Array.from(disabledToolsSet);

  // Wide content area for tabs that benefit from it: documentation needs
  // room for the TOC + reading column; tools is dense with banners.
  const wide = tab === "documentation" || tab === "tools";

  return (
    <AppShell
      title={meta.title}
      subtitle={meta.subtitle}
      displayName={config.displayName}
      wide={wide}
    >
      <DestructiveVarsBanner />
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
        disabledTools={disabledTools}
        tenantIds={tenantIds}
      />
    </AppShell>
  );
}
