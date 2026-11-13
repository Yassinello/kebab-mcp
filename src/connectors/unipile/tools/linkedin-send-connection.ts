/**
 * Phase 68 / Plan 06 / Task 1 — linkedin_send_connection tool.
 *
 * The WRITE tool that closes phase 68: re-validates the Antoine Vercken
 * connect flow that failed 2026-05-18 with Browserbase. Implements the
 * 8-step handler from RESEARCH.md §Code Examples, honoring the locked
 * envelope contracts D-13 / D-14 / D-15 / D-20.
 *
 * Envelope (D-14, LOCKED — NEVER `verified: 'pending'`):
 *   {
 *     provider_ok: boolean,
 *     verified: boolean,             // D-13/D-15: strictly boolean
 *     crm_sync: "pending",            // D-01: hardcoded literal in phase 68
 *     dedup_hit: boolean,
 *     audit_id: string,
 *     invitation_id?: string,
 *     error?: AuditResult | "error_no_linkedin_account" | "error_account_id_required",
 *     available_accounts?: string[],  // populated on error_account_id_required
 *   }
 *
 * Verify-after-write (D-13): 3 polls at exactly [2000, 5000, 10000] ms
 *   (~17s total). On success → `verified: true`. On timeout → `verified: false`
 *   with `error: 'unverified_timeout'` (D-15) — never silent ambiguity.
 *
 * account_id resolution (D-20):
 *   - if `args.account_id` provided → use it silently (no account.getAll call).
 *   - else `account.getAll()` → filter type === "LINKEDIN":
 *     · 0 → `error_no_linkedin_account`
 *     · 1 → use it silently
 *     · ≥2 → `error_account_id_required` with `available_accounts` list
 *
 * Dedup (D-05 / D-06): the LLM caller CANNOT bypass dedup — there is no
 *   `dedup_key`, `bypassDedup`, or `forceWrite` parameter on the schema.
 *   Changing 1 char in the note bypasses dedup (intentional — D-05 design).
 *
 * Audit: every code path writes an audit row via `writeAuditRow` (Plan 04).
 *   Dedup hits also write a row with `dedup_hit: true` and a fresh `audit_id`,
 *   mirroring `result`/`verified` from the cached row for trace continuity
 *   (T-68-06-04 mitigation).
 */

import { z } from "zod";
import { previewIdField } from "../lib/common-schema";
import type { ToolResult } from "@/core/types";
import { getUnipileClient } from "../lib/client";
import { withRetry } from "../lib/retry";
import { resolveProviderId, normalizeProfileUrl } from "../lib/identifiers";
import {
  computeParamsHash,
  checkDedup,
  writeAuditRow,
  generateAuditId,
  type AuditResult,
} from "../lib/audit";
import { resolveAccountId } from "../lib/account";
import { crmBridge } from "../lib/crm-bridge";
import { classifyUnipileError } from "../lib/errors";
import { checkUnipileRateLimit } from "../lib/rate-limiter";
import { readHaltFlag } from "../webhook/halt-flag";
import { isWritesDisabled } from "../lib/kill-switch";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";

const log = getLogger("CONNECTOR:unipile");

export const linkedinSendConnectionSchema = {
  profile_url: z
    .string()
    .url()
    .describe(
      "Public LinkedIn profile URL (https://linkedin.com/in/<slug>; locale prefixes accepted)."
    ),
  note: z
    .string()
    .max(300)
    .optional()
    .describe(
      "Optional connection request note (≤300 chars LinkedIn cap). Changing 1 char in the note bypasses dedup — this is intentional (D-05)."
    ),
  preview_id: previewIdField,
  account_id: z
    .string()
    .optional()
    .describe(
      "Unipile LinkedIn account_id. Optional — if exactly one LinkedIn account is connected, it is used silently. If multiple, account_id is required."
    ),
  actor_user_id: z
    .string()
    .describe("User id of the operator triggering the call. Recorded in the audit log."),
  crm_log: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Free-form CRM payload passed to the outbox row. Phase 70 will POST this to UNIPILE_CRM_WEBHOOK_URL."
    ),
};

type SendArgs = {
  profile_url: string;
  note?: string;
  account_id?: string;
  actor_user_id: string;
  crm_log?: Record<string, unknown>;
};

interface SendEnvelope {
  provider_ok: boolean;
  verified: boolean;
  crm_sync: "pending"; // D-01: hardcoded literal in phase 68
  dedup_hit: boolean;
  audit_id: string;
  invitation_id?: string;
  error?: string;
  available_accounts?: string[]; // populated on error_account_id_required (D-20)
  // === Phase 69 / Plan 06 retrofit (D-43) — rate-limit envelope fields ===
  // Only populated when the kebab-side per-account rate-limiter blocks (distinct
  // from Unipile-side 429 which still routes to error_rate_limit). See D-49 for
  // handler ordering (dedup FIRST, rate-limit AFTER account-resolve).
  blocked_by_rate_limit?: boolean;
  daily_used?: number;
  daily_limit?: number;
  weekly_used?: number;
  weekly_limit?: number;
  retry_after?: string;
  // === Phase 70 / Plan 70-03 retrofit (D-65/D-66) — halt-flag envelope fields ===
  // Only populated when error === "error_account_halted".
  reason?: string;
  halted_at?: string;
}

function envelope(e: SendEnvelope): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }],
  };
}

/**
 * D-13 verify-after-write: 3 polls at [2000, 5000, 10000] ms (~17s total budget).
 * Confirms send by listing sent invitations and checking invited_user_id === provider_id.
 *
 * D-16: transient errors during polling are NOT fatal — we continue to the next delay.
 * The poll budget is bounded so the worst-case wall-clock stays well inside
 * Vercel's 60s lambda budget.
 *
 * Per Assumption A3 (RESEARCH.md): if Unipile's real-world propagation latency
 * consistently exceeds 17s, the operator will see `verified: false` even on
 * actual success — at that point we re-evaluate the budget.
 */
async function pollForRelation(
  accountId: string,
  providerId: string,
  delaysMs: number[]
): Promise<boolean> {
  const client = getUnipileClient();
  for (const delay of delaysMs) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const invitations = await client.users.getAllInvitationsSent({ account_id: accountId });
      const items =
        (invitations as { items?: Array<{ invited_user_id: string | null }> }).items ?? [];
      if (items.some((i) => i.invited_user_id === providerId)) return true;
    } catch (err) {
      // D-16: transient poll error is not fatal — continue to next delay.
      // M-02: mirror pollForMessage shape so operators investigating waves of
      // `unverified_timeout` have log breadcrumbs (was a bare `} catch {}`).
      log.warn("pollForRelation transient error", {
        accountId,
        providerId,
        delay,
        err: toMsg(err),
      });
    }
  }
  return false;
}

export async function handleLinkedinSendConnection(args: SendArgs): Promise<ToolResult> {
  const auditId = generateAuditId();

  // Best-effort normalization; on unsupported shapes fall through with the raw
  // URL so the SDK produces a meaningful error downstream (rather than dying
  // here with a normalization throw and skipping the audit trail).
  const profileUrlNormalized = (() => {
    try {
      return normalizeProfileUrl(args.profile_url);
    } catch {
      return args.profile_url;
    }
  })();

  const paramsHash = computeParamsHash({
    tool: "linkedin_send_connection",
    profile_url_normalized: profileUrlNormalized,
    note: args.note ?? "",
  });

  // ═══════ Step -1: KILL-SWITCH (D-86/D-88/D-89 — highest-priority gate, NEW in Plan 71-01) ═══════
  // Global kill switch — set by operator (KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true
  // or legacy alias LINKEDIN_TOOLS_DISABLED=true) to halt ALL LinkedIn writes at
  // once. Reads BEFORE account-resolve so we don't burn a Unipile API call
  // enumerating accounts when writes are globally disabled. NO accountId is
  // known yet — the audit row's account_id field stays "" (matches the D-20
  // account-resolve error path's existing pattern at line 221).
  if (isWritesDisabled()) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_connection",
      account_id: args.account_id ?? "",
      params_hash: paramsHash,
      result: "error_writes_disabled",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    log.warn("send_connection refused — KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED");
    return envelope({
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      error: "error_writes_disabled",
    });
  }

  // ═══════ Step 0a: ACCOUNT-RESOLVE (D-20 — MOVED UP from Step 2 so halt-check has an accountId) ═══════
  // Phase 70 Plan 70-03 (D-65/D-66): halt-check is the highest-priority gate,
  // BEFORE dedup. Account-resolve must precede halt-check because the halt
  // flag is keyed by account_id. account.getAll() is a cheap read enumeration
  // with no provider write side-effects and no rate-limit cost, so this
  // reorder is safe vs the original D-49 dedup-first ordering.
  // exactOptionalPropertyTypes: only pass `account_id` when defined (matches
  // the shared lib's `args.account_id` signature and the engage call site).
  const acct = await resolveAccountId(
    args.account_id !== undefined ? { account_id: args.account_id } : {}
  );
  if ("error" in acct) {
    // D-20 errors classify as 'restricted' in the audit enum (the operator
    // misconfigured their Unipile account wiring — treat as a hard auth gate).
    const result: AuditResult = "error_account_restricted";
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_connection",
      account_id: args.account_id ?? "",
      params_hash: paramsHash,
      result,
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    const env: SendEnvelope = {
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      error: acct.error,
    };
    if ("available_accounts" in acct) env.available_accounts = acct.available_accounts;
    return envelope(env);
  }
  const accountId = acct.accountId;

  // ═══════ Step 0b: HALT-CHECK (D-65/D-66 — highest-priority gate, NEW in Plan 70-03) ═══════
  // If the account_status webhook handler (Plan 70-02) set a halt flag, refuse
  // immediately. NO dedup check, NO rate-limit, NO SDK call. Single minimal audit row.
  const halt = await readHaltFlag(accountId);
  if (halt) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_connection",
      account_id: accountId,
      params_hash: paramsHash,
      result: "error_account_halted",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    log.warn("send_connection halted (account flag set)", {
      account_id: accountId,
      reason: halt.reason,
      status: halt.status,
      halted_at: halt.halted_at,
    });
    return envelope({
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      error: "error_account_halted",
      reason: halt.reason,
      halted_at: halt.halted_at,
    });
  }

  // ═══════ Step 1: DEDUP (D-05 / D-06 — runs AFTER halt-check per D-66) ═══════
  const dup = await checkDedup(paramsHash);
  if (dup) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_connection",
      account_id: accountId,
      params_hash: paramsHash,
      result: dup.result, // mirror prior result for trace continuity (T-68-06-04)
      verified: dup.verified,
      dedup_hit: true,
      timestamp: new Date().toISOString(),
    });
    return envelope({
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: true,
      audit_id: auditId,
    });
  }

  // 2b. Phase 69 retrofit (D-43 + D-49) — per-account / per-tool rate-limit.
  //
  // Ordering: dedup FIRST (already ran above at step 1), account-resolve SECOND,
  // rate-limit HERE (step 2b). RESEARCH §4.6 + WARNING-6: send_connection has
  // NO attachment pre-flight and NO degree gate, so rate-limit fires immediately
  // after account-resolve — there is no pre-flight refusal that needs to come
  // first.
  const rl = await checkUnipileRateLimit({ account_id: accountId, tool: "send_connection" });
  if (rl.blocked) {
    // WARNING-5: capture cap-context in observability (audit schema has no
    // metadata column — log.warn is the only surface that carries weekly
    // counters + retry_after for operator dashboards).
    log.warn("Rate-limit blocked send_connection", {
      account_id: accountId,
      tool: "send_connection",
      daily_used: rl.daily_used,
      daily_limit: rl.daily_limit,
      weekly_used: rl.weekly_used,
      weekly_limit: rl.weekly_limit,
      retry_after: rl.retry_after,
      reason: rl.reason,
    });
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_connection",
      account_id: accountId,
      params_hash: paramsHash,
      result: "error_rate_limit_kebab",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    const env: SendEnvelope = {
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      error: "error_rate_limit_kebab",
      blocked_by_rate_limit: true,
      daily_used: rl.daily_used,
      daily_limit: rl.daily_limit,
    };
    if (rl.weekly_used !== undefined) env.weekly_used = rl.weekly_used;
    if (rl.weekly_limit !== undefined) env.weekly_limit = rl.weekly_limit;
    if (rl.retry_after) env.retry_after = rl.retry_after;
    return envelope(env);
  }

  // 3. Resolve provider_id (KV cache + SDK fallback). On 429 / error: surface.
  let providerId: string;
  try {
    const r = await resolveProviderId(args.profile_url, accountId);
    providerId = r.provider_id;
  } catch (err) {
    const result = classifyUnipileError(err);
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_connection",
      account_id: accountId,
      params_hash: paramsHash,
      result,
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    return envelope({
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      error: result,
    });
  }

  // 4. CRM outbox row (D-01: skeleton writes status='pending' and stops)
  await crmBridge.writeOutbox(auditId, { crm_log: args.crm_log ?? null });

  // 5. Send invitation (with retry on 429 / 5xx)
  let invitationId: string | undefined;
  try {
    const resp = await withRetry(() =>
      getUnipileClient().users.sendInvitation({
        account_id: accountId,
        provider_id: providerId,
        ...(args.note ? { message: args.note } : {}),
      })
    );
    invitationId = (resp as { invitation_id?: string }).invitation_id;
  } catch (err) {
    const result = classifyUnipileError(err);
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_connection",
      account_id: accountId,
      params_hash: paramsHash,
      result,
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    return envelope({
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      error: result,
    });
  }

  // 6. Verify-after-write (D-13: 3 polls @ 2s / 5s / 10s)
  const verified = await pollForRelation(accountId, providerId, [2000, 5000, 10000]);
  const result: AuditResult = verified ? "success" : "unverified_timeout";

  // 7. Write final audit row
  await writeAuditRow({
    audit_id: auditId,
    actor_user_id: args.actor_user_id,
    tool: "linkedin_send_connection",
    account_id: accountId,
    params_hash: paramsHash,
    result,
    verified,
    dedup_hit: false,
    timestamp: new Date().toISOString(),
  });

  // 8. Return envelope (D-14)
  const out: SendEnvelope = {
    provider_ok: true,
    verified,
    crm_sync: "pending",
    dedup_hit: false,
    audit_id: auditId,
  };
  if (invitationId) out.invitation_id = invitationId;
  if (!verified) out.error = "unverified_timeout";
  return envelope(out);
}
