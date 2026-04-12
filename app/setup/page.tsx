import { redirect } from "next/navigation";
import { SetupWizard } from "./wizard";
import { AppShell } from "../sidebar";
import { getInstanceConfig } from "@/core/config";

export const dynamic = "force-dynamic";

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ add?: string }>;
}) {
  const params = await searchParams;
  const hasToken = !!process.env.MCP_AUTH_TOKEN;
  const isFirstTime = !hasToken;
  const isVercel = !!process.env.VERCEL;
  const config = getInstanceConfig();

  // Post-first-run: /setup without `add` query param redirects to /config.
  // `add` present (even empty) means "add-pack mode".
  const addMode = params.add !== undefined;
  if (hasToken && !addMode) {
    redirect("/config");
  }

  return (
    <AppShell
      title={isFirstTime ? "Welcome to MyMCP" : "Add a pack"}
      subtitle={
        isFirstTime
          ? "Let's get your personal MCP server configured in a few minutes."
          : "Connect a new pack to your running server."
      }
      displayName={config.displayName}
      setupMode={isFirstTime}
      narrow
    >
      <SetupWizard
        firstTime={isFirstTime}
        isVercel={isVercel}
        hasToken={hasToken}
        initialPack={params.add || undefined}
      />
    </AppShell>
  );
}
