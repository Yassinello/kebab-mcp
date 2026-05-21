/**
 * Phase 69 / Plan 01 — shared D-20 LinkedIn account resolver.
 * Phase 72 — pinned-default extension (UNIPILE_<TYPE>_ACCOUNT_ID).
 *
 * Extracted from `tools/linkedin-send-connection.ts` (and its duplicate in
 * `linkedin-get-relationship-status.ts`) so the 4 phase-69 tools
 * (`linkedin_send_message`, `linkedin_send_inmail`, `linkedin_engage`,
 * `linkedin_list_pending`) + the retrofit of `linkedin_send_connection`
 * can all share one source of truth. PATTERNS.md flagged the looming
 * 4-way drift as the highest-leverage anti-drift extraction in phase 69;
 * shipping in Wave 1 unblocks Wave 2 plans to import this directly.
 *
 * D-20 behavior (LOCKED from phase 68):
 *   - explicit `args.account_id` → use silently (NO `account.getAll` call,
 *     no surprise side effects, no extra round-trip).
 *   - else `account.getAll()` → filter `type === "LINKEDIN"`:
 *     · 0 → `{ error: "error_no_linkedin_account" }`
 *     · 1 → `{ accountId }`                           (silent)
 *     · ≥2 → `{ error: "error_account_id_required",
 *               available_accounts: string[] }`
 *
 * D-72 (phase 72 — pinned default, inserted BETWEEN explicit-arg and the
 * count-based rules above): when no explicit `args.account_id` is given but
 * the operator pinned a default via `UNIPILE_<TYPE>_ACCOUNT_ID` env var
 * (e.g. `UNIPILE_LINKEDIN_ACCOUNT_ID`), the resolver uses it — but only
 * AFTER validating it still exists in the `account.getAll()` list for that
 * type. Rationale: a shared Unipile token (e.g. a team Brevo token wired to
 * 5 LinkedIn accounts) makes the ≥2 → `error_account_id_required` safety net
 * fire on every call; pinning the operator's own account fixes that without
 * forcing `account_id` on every tool invocation. The pinned value is a
 * VALIDATED default, NOT a silent override: if the account was removed or
 * the token swapped (pinned id no longer in the list) we fall through to the
 * normal count-based rules (1 → silent, ≥2 → `error_account_id_required`)
 * rather than firing an invite into the void. This costs the same single
 * `getAll()` the no-arg path already pays — no extra round-trip vs today.
 * Explicit `args.account_id` still wins first and still skips `getAll()`.
 *
 * The phase-68 tools (`linkedin-send-connection.ts`,
 * `linkedin-get-relationship-status.ts`) keep their LOCAL copies of this
 * function in THIS plan to avoid coupling Wave 1 with the existing tools'
 * test surface. Wave 2/3 plans (03/04/05/06) will switch them to import
 * from here — at that point the local copies are deleted.
 *
 * D-16 (transient handling): the `account.getAll()` call is wrapped in
 * `withRetry` so transient 429/5xx do not surface as `error_no_linkedin_account`.
 * A persistent failure throws the underlying `UnsuccessfulRequestError` to the
 * caller, which classifies it via `classifyUnipileError` as usual.
 *
 * D-89: env reads go through `getConfig()` (request-context aware,
 * tenant-scoped), NEVER `process.env`.
 */

import { getConfig } from "@/core/config-facade";
import { getUnipileClient } from "./client";
import { withRetry } from "./retry";

interface ResolveArgs {
  account_id?: string;
}

interface UnipileAccountItem {
  id: string;
  type: string;
}

/**
 * Read the pinned-default account id for a Unipile account `type`.
 * Convention: `UNIPILE_LINKEDIN_ACCOUNT_ID`, `UNIPILE_WHATSAPP_ACCOUNT_ID`, …
 * Empty / unset → undefined (caller falls through to count-based rules).
 */
function pinnedAccountIdFor(type: string): string | undefined {
  // Reading config must never break account resolution. A pinned default is a
  // convenience, not a correctness requirement — if the config read throws for
  // any reason, behave as if nothing was pinned and fall through to the
  // count-based rules. (Also keeps the resolver decoupled from the request-
  // context wiring that some unit tests partially mock.)
  let raw: string | undefined;
  try {
    raw = getConfig(`UNIPILE_${type}_ACCOUNT_ID`);
  } catch {
    return undefined;
  }
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Shared resolver core. `errorNoAccount` is the type-specific "zero accounts"
 * enum literal so the LinkedIn surface can keep its locked
 * `error_no_linkedin_account` value while the provider-agnostic surface uses
 * `error_no_account`.
 */
async function resolveForType<E extends string>(
  type: string,
  args: ResolveArgs,
  errorNoAccount: E
): Promise<
  | { accountId: string }
  | { error: E }
  | { error: "error_account_id_required"; available_accounts: string[] }
> {
  // Step 1 (LOCKED D-20): explicit account_id wins, no getAll round-trip.
  if (args.account_id) return { accountId: args.account_id };

  const resp = await withRetry(() => getUnipileClient().account.getAll());
  const items = (resp as { items?: UnipileAccountItem[] }).items ?? [];
  const matching = items.filter((i) => i.type === type).map((i) => i.id);

  if (matching.length === 0) return { error: errorNoAccount };

  // Step 2 (D-72): pinned default, validated against the live list.
  const pinned = pinnedAccountIdFor(type);
  if (pinned && matching.includes(pinned)) return { accountId: pinned };
  // pinned set but absent (account removed / token swapped) → fall through to
  // the count-based rules below rather than using a stale id.

  // Step 3 (LOCKED D-20): exactly one → silent.
  if (matching.length === 1) return { accountId: matching[0]! };

  // Step 4 (LOCKED D-20): ≥2 and nothing usable pinned → safety net.
  return { error: "error_account_id_required", available_accounts: matching };
}

export type AccountResolution =
  | { accountId: string }
  | { error: "error_no_linkedin_account" }
  | { error: "error_account_id_required"; available_accounts: string[] };

export async function resolveAccountId(args: ResolveArgs): Promise<AccountResolution> {
  return resolveForType("LINKEDIN", args, "error_no_linkedin_account");
}

export type ProviderAccountResolution =
  | { accountId: string }
  | { error: "error_no_account" }
  | { error: "error_account_id_required"; available_accounts: string[] };

/**
 * Provider-agnostic counterpart to `resolveAccountId`. Resolves the single
 * connected account of a given Unipile `type` (e.g. "WHATSAPP", "LINKEDIN").
 * Same D-20 + D-72 semantics — explicit account_id wins silently; otherwise a
 * validated `UNIPILE_<TYPE>_ACCOUNT_ID` pinned default; otherwise 0 →
 * error_no_account, 1 → silent, ≥2 → error_account_id_required. Kept separate
 * from `resolveAccountId` so the LinkedIn tools' locked
 * `error_no_linkedin_account` enum is untouched.
 */
export async function resolveAccountIdForType(
  type: string,
  args: ResolveArgs
): Promise<ProviderAccountResolution> {
  return resolveForType(type, args, "error_no_account");
}
