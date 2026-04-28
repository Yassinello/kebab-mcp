import { NextResponse } from "next/server";
import { isClaimer, isFirstRunMode } from "@/core/first-run";
import { checkAdminAuth } from "@/core/auth";
import { isLoopbackRequest, getClientIP } from "@/core/request-utils";
import { checkRateLimit } from "@/core/rate-limit";
import { loadConnectorManifest } from "@/core/registry";
import { withTimeout } from "@/core/timeout";
import { composeRequestPipeline, rehydrateStep, type PipelineContext } from "@/core/pipeline";

/**
 * POST /api/setup/test
 *
 * Test a single credential draft by delegating to the connector's own
 * `testConnection()` method. Credentials come from the wizard form —
 * they have NOT been persisted yet, so implementations read from the
 * `credentials` argument, never from `process.env`.
 *
 * Auth: either admin auth (post-setup, from dashboard) or first-run
 * claimer (during /welcome setup). Both are valid callers.
 */

const TEST_TIMEOUT_MS = 8_000;

async function postHandler(ctx: PipelineContext) {
  const request = ctx.request;
  // Post-setup: accept admin auth (cookie or token) so the Connectors
  // tab can test credentials from the dashboard. The auth check uses
  // !isFirstRunMode() instead of getConfig("MCP_AUTH_TOKEN") because the
  // token may live in the bootstrap cache (rehydrated from Upstash KV)
  // rather than process.env on Vercel cold lambdas. Reading the env
  // directly returned undefined and shunted authenticated dashboard
  // users into the first-run-only path, where they predictably failed
  // the claimer check with "Unauthorized — claim this instance via
  // /welcome first" (caught on Obsidian Test connection, 2026-04-28).
  if (!isFirstRunMode()) {
    const authError = await checkAdminAuth(request);
    if (authError) return authError;
  } else {
    // First-run mode: accept loopback or claimer cookie
    if (!isLoopbackRequest(request) && !(await isClaimer(request))) {
      return NextResponse.json(
        { error: "Unauthorized — claim this instance via /welcome first" },
        { status: 401 }
      );
    }
  }

  const ip = getClientIP(request);
  const rl = await checkRateLimit(`ip:${ip}`, { scope: "setup", limit: 10 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded — try again in a minute" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  let body: { pack?: string; credentials?: Record<string, string> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON body" }, { status: 400 });
  }

  const packId = body.pack;
  const credentials = body.credentials || {};
  if (!packId) {
    return NextResponse.json({ ok: false, message: "Missing pack" }, { status: 400 });
  }

  // PERF-01: force-load the full manifest even if the connector is disabled
  // by missing env vars. The wizard tests DRAFT credentials before they are
  // persisted, so we cannot rely on gated resolve (it would return a stub
  // manifest with no `testConnection`). loadConnectorManifest() still dedupes
  // via the in-flight Map so we don't repeat the import if another resolve
  // is already in flight.
  const manifest = await loadConnectorManifest(packId);
  if (!manifest) {
    return NextResponse.json({ ok: true, message: "No test available" });
  }
  if (!manifest.testConnection) {
    return NextResponse.json({ ok: true, message: "No test available" });
  }

  try {
    const result = await withTimeout(
      manifest.testConnection(credentials),
      TEST_TIMEOUT_MS,
      `${packId} testConnection()`
    );
    return NextResponse.json(result);
  } catch (err) {
    // v0.6 HIGH-3: never echo raw err.message to the caller. Test
    // connections hit arbitrary third-party APIs whose error bodies may
    // contain the credentials the caller just tried (e.g., an OAuth
    // provider echoing back `client_secret=sk_live_…` in a 401 body,
    // or a Slack API dumping the bot token when the scope is wrong).
    // We surface a generic message + the error class only.
    return NextResponse.json({
      ok: false,
      message: "Connection failed",
      detail: sanitizeSetupTestError(err),
    });
  }
}

/**
 * Produce a caller-safe string from a test-connection failure. We keep
 * the error constructor name for debuggability but drop the message.
 */
function sanitizeSetupTestError(err: unknown): string {
  if (err instanceof Error) {
    // Common benign shapes we can safely preserve.
    const name = err.name && err.name !== "Error" ? err.name : "Error";
    if (err.name === "AbortError" || /timeout/i.test(err.message)) {
      return `${name}: timeout`;
    }
    return name;
  }
  return "Error";
}

export const POST = composeRequestPipeline([rehydrateStep], postHandler);
