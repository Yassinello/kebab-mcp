import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { timingSafeEqual } from "node:crypto";
import { isFirstRunMode, isBootstrapActive } from "@/core/first-run";
import { WelcomeShell } from "./WelcomeShell";

export const dynamic = "force-dynamic";

function safeEq(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function isAdminAuthed(): Promise<boolean> {
  const expected = (process.env.ADMIN_AUTH_TOKEN || process.env.MCP_AUTH_TOKEN)?.trim();
  if (!expected) return false;
  const cookieStore = await cookies();
  const cookieToken = cookieStore.get("mymcp_admin_token")?.value?.trim();
  if (cookieToken && safeEq(cookieToken, expected)) return true;
  const hdrs = await headers();
  const authHeader = hdrs.get("authorization");
  if (authHeader) {
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (bearer && safeEq(bearer, expected)) return true;
  }
  return false;
}

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string }>;
}) {
  const { preview } = await searchParams;
  const previewRequested = preview === "1";

  const alreadyInitialized = !isFirstRunMode() && !isBootstrapActive();

  // Preview mode: admin-gated, non-destructive. Re-renders /welcome against
  // the live instance with the real permanent token so the operator can
  // visually verify the flow without resetting state or invalidating clients.
  if (previewRequested) {
    const authed = await isAdminAuthed();
    if (!authed) {
      // Don't leak the preview surface to unauthed visitors — send them to
      // the normal redirect path. They can sign in at /config first.
      if (alreadyInitialized) redirect("/config");
    } else {
      const token = (process.env.MCP_AUTH_TOKEN || "").split(",")[0]?.trim() || "";
      const hdrs = await headers();
      const host = hdrs.get("x-forwarded-host") || hdrs.get("host") || "";
      const proto = hdrs.get("x-forwarded-proto") || "https";
      const instanceUrl = host ? `${proto}://${host}` : "";
      return (
        <WelcomeShell
          initialBootstrap={false}
          previewMode
          previewToken={token}
          previewInstanceUrl={instanceUrl}
        />
      );
    }
  }

  if (alreadyInitialized) {
    redirect("/config");
  }

  // Sticky banner if recovery-reset is still on. Without this, users see
  // the wizard, click Generate, and end up with a token that the very
  // next cold lambda wipes — mysterious 503s afterwards. Make the
  // foot-gun visible BEFORE they spend time on the flow.
  const recoveryResetActive = process.env.MYMCP_RECOVERY_RESET === "1";

  return (
    <WelcomeShell
      initialBootstrap={isBootstrapActive()}
      recoveryResetActive={recoveryResetActive}
    />
  );
}
