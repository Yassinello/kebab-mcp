import { AppShell } from "../sidebar";
import { getInstanceConfig } from "@/core/config";
import { resolveRegistry } from "@/core/registry";
import { getRecentLogs } from "@/core/logging";
import { ConfigTabs } from "./tabs";

export const dynamic = "force-dynamic";

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab = params.tab || "overview";
  const config = getInstanceConfig();

  const registry = resolveRegistry();
  const logs = getRecentLogs(100);

  const enabled = registry.filter((p) => p.enabled);
  const totalTools = enabled.reduce((s, p) => s + p.manifest.tools.length, 0);

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const packSummaries = registry.map((p) => ({
    id: p.manifest.id,
    label: p.manifest.label,
    description: p.manifest.description,
    enabled: p.enabled,
    reason: p.reason,
    toolCount: p.manifest.tools.length,
    requiredEnvVars: p.manifest.requiredEnvVars,
    guide: p.manifest.guide,
    tools: p.manifest.tools.map((t) => ({
      name: t.name,
      description: t.description,
      deprecated: t.deprecated,
    })),
  }));

  return (
    <AppShell
      title="Configuration"
      subtitle="Manage packs, tools, settings, and logs — live."
      displayName={config.displayName}
    >
      <ConfigTabs
        activeTab={tab}
        packs={packSummaries}
        totalTools={totalTools}
        enabledCount={enabled.length}
        logs={logs}
        baseUrl={baseUrl}
        config={config}
      />
    </AppShell>
  );
}
