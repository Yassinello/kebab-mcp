/**
 * v0.19 (GMA-05): shared account-resolution helper for the 21 Google tool
 * handlers. Wraps `resolveConnectorAccount("google", …)` and converts a
 * non-account resolution into a returned structured-content error response
 * (NOT a thrown error) — mirroring `slack/lib/resolve-account.ts`.
 *
 * Unlike Slack/Notion (which return a static bearer `AccountTokenSet`),
 * Google returns a `GoogleAuthContext` ({ tokens, slug }): the slug is needed
 * downstream to key the per-account access-token cache, since each account's
 * refresh token mints a distinct short-lived access token.
 */

import type { ToolResult } from "@/core/types";
import { resolveConnectorAccount } from "@/core/connector-accounts";
import type { GoogleAuthContext } from "./google-auth";

/** Discriminated result: an auth context to use, or a ready-to-return error envelope. */
export type GoogleAccountResult =
  | { ok: true; ctx: GoogleAuthContext }
  | { ok: false; result: ToolResult };

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Resolve the Google account for a tool call. `account` is the optional
 * selector from the tool params (name or slug). `exactOptionalPropertyTypes`:
 * only pass `account` when defined.
 */
export async function resolveGoogleTokens(account?: string): Promise<GoogleAccountResult> {
  const resolution = await resolveConnectorAccount(
    "google",
    account !== undefined ? { account } : {}
  );

  if ("account" in resolution) {
    return {
      ok: true,
      ctx: { tokens: resolution.account.tokens, slug: resolution.account.slug },
    };
  }

  if (resolution.error === "error_no_account") {
    return {
      ok: false,
      result: errorResult(
        "Google pack is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN to your environment variables, or connect an account in /config → Connectors."
      ),
    };
  }

  // error_account_required — ≥2 accounts (or an explicit miss): tell the
  // caller to pass `account`, listing the available account names.
  return {
    ok: false,
    result: errorResult(
      `Multiple Google accounts are connected. Re-run with the "account" parameter set to one of: ${resolution.available_accounts.join(", ")}.`
    ),
  };
}
