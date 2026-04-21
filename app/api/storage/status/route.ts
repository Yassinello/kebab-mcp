import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { isClaimer } from "@/core/first-run";
import { isLoopbackRequest } from "@/core/request-utils";
import { detectStorageMode, clearStorageModeCache } from "@/core/storage-mode";
import { getKVStore, kvScanAll } from "@/core/kv-store";
import { CRED_PREFIX } from "@/core/credential-store";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";
import { hasUpstashCreds } from "@/core/upstash-env";

/**
 * GET /api/storage/status
 * Returns the current storage mode + counts.
 *
 * Auth: admin auth when MCP_AUTH_TOKEN is set; otherwise accept first-run
 * claimer or loopback (matches /api/config/storage-status legacy behavior so
 * the welcome flow can call this before the user has minted a token).
 *
 * Query params:
 *   ?force=1 — bust the 60s detection cache (used by "Recheck" button)
 *   ?counts=0 — skip the count scan when only the mode is needed (cheap path)
 */
async function getHandler(request: Request) {
  // Rehydrate is handled by withBootstrapRehydrate at the HOC boundary
  // (DUR-01). Without it, a cold lambda that didn't serve the original
  // /welcome/claim call has no in-memory record of the claim and rejects
  // the welcome flow's status polling with 401, leaving the user stuck
  // on "Detecting your storage…".

  // Accept EITHER a valid first-run claim cookie OR loopback OR admin auth.
  // During bootstrap, the welcome client only has the claim cookie — it
  // doesn't know the freshly-minted MCP_AUTH_TOKEN and can't send it as a
  // bearer header. Gating strictly on `process.env.MCP_AUTH_TOKEN` would
  // force the admin-auth branch on any lambda that has rehydrated the
  // bootstrap, rejecting welcome's status polls with 401. A valid claim
  // cookie is itself proof of being the operator (see isClaimer notes).
  if (!isLoopbackRequest(request) && !(await isClaimer(request))) {
    const authError = await checkAdminAuth(request);
    if (authError) return authError;
  }

  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";
  const wantCounts = url.searchParams.get("counts") !== "0";

  if (force) clearStorageModeCache();

  const report = await detectStorageMode({ force });

  let counts: { credentials: number; skills: number; total: number } | null = null;
  // Counts are only meaningful when KV / file backend is reachable. Static
  // mode means no persisted data — and kv-degraded means we shouldn't hit
  // the (unreachable) backend.
  if (wantCounts && (report.mode === "kv" || report.mode === "file")) {
    try {
      const kv = getKVStore();
      const credKeys = await kvScanAll(kv, `${CRED_PREFIX}*`);
      const skillKeys = await kvScanAll(kv, `skill:*`);
      counts = {
        credentials: credKeys.length,
        skills: skillKeys.length,
        total: credKeys.length + skillKeys.length,
      };
    } catch {
      // Don't fail the whole status call if scan blows up — surface mode anyway.
      counts = null;
    }
  }

  // Backward-compatible legacy fields so the existing welcome page can keep
  // calling /api/config/storage-status until we migrate it. New consumers
  // should use the structured `report` field exclusively.
  return NextResponse.json({
    ...report,
    counts,
    legacy: {
      backend:
        report.mode === "kv"
          ? "upstash"
          : report.mode === "file"
            ? "filesystem"
            : report.mode === "static"
              ? "none"
              : "kv-degraded",
      upstashConfigured: hasUpstashCreds(),
      isVercel: process.env.VERCEL === "1",
    },
  });
}

export const GET = withBootstrapRehydrate(getHandler);
