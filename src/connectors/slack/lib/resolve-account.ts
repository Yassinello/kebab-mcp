/**
 * Phase 74 (MATL-03/04): shared account-resolution helper for the 6 Slack
 * tool handlers. Wraps `resolveConnectorAccount("slack", …)` and converts a
 * non-account resolution into a returned structured-content error response
 * (NOT a thrown error) — mirroring the Unipile tools' error-result style
 * (`linkedin-send-message.ts`), which return an envelope for the
 * ≥2-ambiguous case so the caller can re-invoke with `account`.
 *
 * On success the caller gets the selected account's `AccountTokenSet` to
 * thread into the slack-api layer. On `error_no_account` we surface the
 * same "not configured" message slackFetch raises today; on
 * `error_account_required` we list the available account NAMES so the
 * caller knows what to pass.
 */

import type { ToolResult } from "@/core/types";
import { resolveConnectorAccount, type AccountTokenSet } from "@/core/connector-accounts";

/** Discriminated result: tokens to use, or a ready-to-return error envelope. */
export type SlackAccountResult =
  | { ok: true; tokens: AccountTokenSet }
  | { ok: false; result: ToolResult };

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Resolve the Slack account for a tool call. `account` is the optional
 * selector from the tool params (name or slug). `exactOptionalPropertyTypes`:
 * only pass `account` when defined.
 */
export async function resolveSlackTokens(account?: string): Promise<SlackAccountResult> {
  const resolution = await resolveConnectorAccount(
    "slack",
    account !== undefined ? { account } : {}
  );

  if ("account" in resolution) {
    return { ok: true, tokens: resolution.account.tokens };
  }

  if (resolution.error === "error_no_account") {
    return {
      ok: false,
      result: errorResult(
        "Slack pack is not configured. Add SLACK_BOT_TOKEN to your environment variables."
      ),
    };
  }

  // error_account_required — ≥2 accounts (or an explicit miss): tell the
  // caller to pass `account`, listing the available account names.
  return {
    ok: false,
    result: errorResult(
      `Multiple Slack accounts are connected. Re-run with the "account" parameter set to one of: ${resolution.available_accounts.join(", ")}.`
    ),
  };
}
