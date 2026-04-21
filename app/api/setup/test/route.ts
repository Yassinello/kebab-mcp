import { NextResponse } from "next/server";
import { isClaimer } from "@/core/first-run";
import { checkAdminAuth } from "@/core/auth";
import { isLoopbackRequest, getClientIP } from "@/core/request-utils";
import { checkRateLimit } from "@/core/rate-limit";
import { resolveRegistry } from "@/core/registry";
import { withTimeout } from "@/core/timeout";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

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

async function postHandler(request: Request) {
  // Post-setup: accept admin auth (cookie or token) so the Connectors
  // tab can test credentials from the dashboard.
  if (process.env.MCP_AUTH_TOKEN) {
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

  const state = resolveRegistry().find((c) => c.manifest.id === packId);
  if (!state) {
    return NextResponse.json({ ok: true, message: "No test available" });
  }
  if (!state.manifest.testConnection) {
    return NextResponse.json({ ok: true, message: "No test available" });
  }

  try {
    const result = await withTimeout(
      state.manifest.testConnection(credentials),
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

export const POST = withBootstrapRehydrate(postHandler);
