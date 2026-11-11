/**
 * Zod fragments shared by the spec-v2 tools (ADR 0002).
 */

import { z } from "zod";

export const confirmField = z
  .boolean()
  .default(false)
  .describe(
    "Safety gate. false (default) = PREVIEW ONLY: returns exactly what would be sent, sends nothing. " +
      "Set true ONLY after the user explicitly approved that exact preview."
  );

export const actorUserIdField = z
  .string()
  .max(200)
  .optional()
  .describe("Optional operator id recorded in the audit log (defaults to 'mcp').");

export function accountIdField(channel: "LinkedIn" | "WhatsApp") {
  return z
    .string()
    .optional()
    .describe(
      `Unipile ${channel} account_id. Optional when exactly one ${channel} account is connected or a default is pinned in /config.`
    );
}

export function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Pass `account_id` only when defined (exactOptionalPropertyTypes). */
export function accountArg(accountId: string | undefined): { account_id?: string } {
  return accountId !== undefined ? { account_id: accountId } : {};
}
