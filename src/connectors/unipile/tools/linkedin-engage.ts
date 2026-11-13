/**
 * Phase 69 / Plan 06 / Task 1 — linkedin_engage super-tool (UNI-09).
 *
 * THIS IS A THIN DISPATCHER. All actual SDK calls happen in the three
 * delegate handlers (`send_message`, `send_connection`, `send_inmail`).
 * Engage owns: degree resolution, routing decision, dry-run preview, and
 * ONE additional audit row for the dry-run path. Engage does NOT call
 * the rate-limiter directly — the delegates own their own rate-limit /
 * dedup / audit.
 *
 * Envelope shape (D-30 — discriminated union):
 *   { action: "sent_message",  degree, delegate_envelope }
 *   { action: "sent_connection", degree, delegate_envelope }
 *   { action: "sent_inmail",   degree, delegate_envelope }
 *   { action: "skipped", reason: <string>, degree }
 *   { action: "dry_run_proposed", proposed_action, degree, dry_run: true,
 *     audit_id, [reason], [would_skip_with_reason] }
 *
 * Locked decisions (see .planning/phases/69-linkedin-writes/69-CONTEXT.md):
 *
 *   D-30 — Discriminated union return shape with `action` discriminator.
 *
 *   D-31 — Routing (BLOCKER-1 refines the InMail branch):
 *     degree=1  → send_message (or skipped with `no_message_provided` if
 *                  no message)
 *     degree=2|3 → send_connection (pass `note?` through)
 *     OON/null + fallback_if_unreachable="inmail" + allow_inmail=true
 *               + inmail_subject provided        → send_inmail (pass subject)
 *     OON/null + InMail allowed but NO subject  → skipped with
 *                  reason="skipped_no_inmail_subject" (mirrors the
 *                  1st-degree skipped_no_message pattern — operator gets
 *                  clear actionable feedback)
 *     otherwise → skipped with reason="unreachable_no_inmail_fallback"
 *
 *   D-32 — dry_run: true returns the proposed action + degree WITHOUT calling
 *     rate-limiter, WITHOUT calling provider write APIs. Verifiable via grep:
 *     `grep -nE "args\.dry_run\s*===\s*true" linkedin-engage.ts` returns ≥1
 *     line — proves the gate runs BEFORE any provider call.
 *
 *   D-33 — dry_run writes EXACTLY ONE audit row with result: "dry_run" (the
 *     bill-of-actions feature — operator can preview a batch and see exactly
 *     which audit_ids the real run would create).
 *
 * Anti-drift:
 *  - NEVER `verified: "pending"` literal — the delegates own the envelope
 *    for that, and `verified` stays a strict boolean per D-13/D-14.
 *  - Pre-flight refusals (dry_run, no_message_provided, skipped_*) MUST NOT
 *    count toward any rate-limit cap — delegates own rate-limit; engage
 *    only runs `getProfile` (read) for degree resolution.
 *  - The delegates themselves enforce dedup + rate-limit + audit when engage
 *    routes to them. Engage does NOT duplicate any of that work.
 */

import { z } from "zod";
import { previewIdField } from "../lib/common-schema";
import type { ToolResult } from "@/core/types";
import { getUnipileClient } from "../lib/client";
import { withRetry } from "../lib/retry";
import { normalizeProfileUrl } from "../lib/identifiers";
import { resolveAccountId } from "../lib/account";
import { computeParamsHash, writeAuditRow, generateAuditId } from "../lib/audit";
import { classifyUnipileError } from "../lib/errors";
import { handleLinkedinSendMessage } from "./linkedin-send-message";
import { handleLinkedinSendConnection } from "./linkedin-send-connection";
import { handleLinkedinSendInmail } from "./linkedin-send-inmail";
import { readHaltFlag } from "../webhook/halt-flag";
import { isWritesDisabled } from "../lib/kill-switch";
import { getLogger } from "@/core/logging";

const log = getLogger("CONNECTOR:unipile");

export const linkedinEngageSchema = {
  profile_url: z
    .string()
    .url()
    .describe(
      "Public LinkedIn profile URL. Engage will resolve degree and route to the appropriate tool."
    ),
  message: z
    .string()
    .min(1)
    .max(8000)
    .optional()
    .describe(
      "Message body (used ONLY for the send_message branch — when target is 1st-degree). " +
        "Without a message, 1st-degree targets are skipped with reason no_message_provided."
    ),
  note: z
    .string()
    .max(300)
    .optional()
    .describe(
      "Connection note (used ONLY for the send_connection branch — when target is 2nd/3rd degree). " +
        "Discretionary param: pass it when you have a personalized opener."
    ),
  allow_inmail: z
    .boolean()
    .default(false)
    .describe(
      "If true AND target is out-of-network AND fallback_if_unreachable='inmail', will send a PAID InMail. " +
        "Default false — same safety gate as direct send_inmail tool (D-26)."
    ),
  fallback_if_unreachable: z
    .enum(["inmail", "skip"])
    .default("skip")
    .describe(
      "What to do when target is out-of-network: 'inmail' (requires allow_inmail=true AND inmail_subject) or 'skip' (default)."
    ),
  inmail_subject: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "BLOCKER-1 fix: optional subject line for the InMail branch. If undefined when the InMail route is chosen, " +
        "engage skips with reason 'skipped_no_inmail_subject' (mirrors 1st-degree skipped_no_message). " +
        "Operators wanting a default 'Outreach' subject must pass it explicitly."
    ),
  dry_run: z
    .boolean()
    .default(false)
    .describe(
      "If true, RESOLVE the degree and return the PROPOSED action — DO NOT call any provider write API. " +
        "Use for bill-of-actions previews on batches of prospects (D-32)."
    ),
  preview_id: previewIdField,
  account_id: z
    .string()
    .optional()
    .describe(
      "Unipile LinkedIn account_id (D-20 — optional if exactly 1 LinkedIn account connected; required if ≥2)."
    ),
  actor_user_id: z.string().describe("Operator user id — audit log."),
  crm_log: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Free-form CRM payload passed through to the chosen delegate."),
};

type EngageArgs = {
  profile_url: string;
  message?: string;
  note?: string;
  allow_inmail?: boolean;
  fallback_if_unreachable?: "inmail" | "skip";
  inmail_subject?: string;
  dry_run?: boolean;
  account_id?: string;
  actor_user_id: string;
  crm_log?: Record<string, unknown>;
};

type Degree = 1 | 2 | 3 | null;

/**
 * Map Unipile's network_distance enum to the public 1|2|3|null degree.
 *
 * Pitfall 3 (carry from phase 68): a MISSING `network_distance` field is
 * NOT "third degree" — it is `null` (unknown / private profile). Defaulting
 * to 3 would silently classify strangers as warm targets.
 *
 * Historical alias support: `DISTANCE_1` / `DISTANCE_2` / `DISTANCE_3` were
 * used by an older SDK shape; we accept both forms so legacy fixtures and
 * any odd-tenant responses continue to route correctly.
 */
function mapDegree(networkDistance: string | undefined | null): Degree {
  if (networkDistance === "FIRST_DEGREE" || networkDistance === "DISTANCE_1") return 1;
  if (networkDistance === "SECOND_DEGREE" || networkDistance === "DISTANCE_2") return 2;
  if (networkDistance === "THIRD_DEGREE" || networkDistance === "DISTANCE_3") return 3;
  return null;
}

type Route =
  | "send_message"
  | "send_connection"
  | "send_inmail"
  | "skipped_no_message"
  | "skipped_no_inmail_subject"
  | "skipped_no_inmail_body"
  | "skipped_unreachable";

/**
 * Pure routing function — same logic for dry_run preview and real dispatch.
 * D-31 + BLOCKER-1.
 */
function routeFromDegree(degree: Degree, args: EngageArgs): Route {
  if (degree === 1) {
    return args.message ? "send_message" : "skipped_no_message";
  }
  if (degree === 2 || degree === 3) {
    return "send_connection";
  }
  // null / out-of-network
  if (args.fallback_if_unreachable === "inmail" && args.allow_inmail === true) {
    // BLOCKER-1: InMail requires a subject. Without one, skip with explicit
    // reason mirroring the 1st-degree skipped_no_message pattern.
    if (!args.inmail_subject) {
      return "skipped_no_inmail_subject";
    }
    // H-01: InMail also requires a body. Without one, skip with explicit
    // reason — avoids dispatching a blank-body paid InMail (LinkedIn either
    // rejects with opaque error OR burns the credit on an empty message).
    if (!args.message) {
      return "skipped_no_inmail_body";
    }
    return "send_inmail";
  }
  return "skipped_unreachable";
}

interface EngageEnvelope {
  action: "sent_message" | "sent_connection" | "sent_inmail" | "skipped" | "dry_run_proposed";
  proposed_action?: "send_message" | "send_connection" | "send_inmail" | "skipped";
  dry_run?: true;
  reason?: string;
  would_skip_with_reason?: string;
  degree?: Degree;
  audit_id?: string;
  error?: string;
  available_accounts?: string[];
  delegate_envelope?: Record<string, unknown>;
  // === Phase 70 / Plan 70-03 retrofit (D-65/D-66) — halt-flag envelope field ===
  // `reason` is already present (used by various skip paths); we additionally
  // surface `halted_at` so the operator knows SINCE WHEN the account was halted.
  halted_at?: string;
}

function envelope(e: EngageEnvelope): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }],
  };
}

/**
 * Resolves the recipient's network distance WITHOUT calling any write API.
 * Used by both dry_run path and the real dispatcher. Wrapped in withRetry
 * so transient 429/5xx don't surface as `null` degree (which would route
 * to the wrong branch — likely "skipped_unreachable").
 */
async function getDegreeOnly(
  args: EngageArgs,
  accountId: string
): Promise<{ degree: Degree } | { error: string }> {
  try {
    // Best-effort slug derivation — mirror identifiers.ts:145 pattern from
    // send-message.ts: normalizeProfileUrl strips trailing slash, then we
    // strip the canonical `https://linkedin.com/in/` prefix.
    const slug = (() => {
      try {
        return normalizeProfileUrl(args.profile_url).replace(/^https?:\/\/linkedin\.com\/in\//, "");
      } catch {
        return args.profile_url;
      }
    })();
    const profile = (await withRetry(() =>
      getUnipileClient().users.getProfile({ account_id: accountId, identifier: slug })
    )) as { network_distance?: string };
    return { degree: mapDegree(profile.network_distance) };
  } catch (err) {
    return { error: classifyUnipileError(err) };
  }
}

export async function handleLinkedinEngage(args: EngageArgs): Promise<ToolResult> {
  const auditId = generateAuditId();

  // M-06: Best-effort URL normalization for the params_hash invariant (D-05).
  // All other tools normalize URL before hashing. Engage previously skipped
  // it — two operators passing `https://www.linkedin.com/in/Yass/` and
  // `https://linkedin.com/in/yass` would get DIFFERENT dry-run audit rows.
  // Mirror the pattern from send-message/send-connection.
  const profileUrlNormalized = (() => {
    try {
      return normalizeProfileUrl(args.profile_url);
    } catch {
      return args.profile_url;
    }
  })();

  // === STEP -1: KILL-SWITCH (D-86/D-88/D-89 — highest-priority gate, NEW in Plan 71-01) ===
  // Global kill switch — even dry_run is blocked. We don't burn the
  // account.getAll() resolution OR the getProfile() degree-fetch when writes
  // are globally disabled. NO accountId known yet — audit row's account_id
  // field stays "" (D-20 precedent). Engage uses its own action: "skipped"
  // envelope shape (not the send-* envelope) — match the pattern used by
  // the halt-check refusal a few lines below.
  if (isWritesDisabled()) {
    const paramsHash = computeParamsHash({
      tool: "linkedin_engage",
      profile_url_normalized: profileUrlNormalized,
      note: "writes_disabled",
    });
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_engage",
      account_id: args.account_id ?? "",
      params_hash: paramsHash,
      result: "error_writes_disabled",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    log.warn("engage refused — KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED");
    return envelope({
      action: "skipped",
      reason: "error_writes_disabled",
      error: "error_writes_disabled",
      degree: null,
      audit_id: auditId,
    });
  }

  // === STEP 0: Resolve account (needed for BOTH dry_run degree fetch AND real dispatch) ===
  // exactOptionalPropertyTypes: only pass `account_id` when defined (carry from
  // phase-69 plan 03's Rule 3 fix).
  const acct = await resolveAccountId(
    args.account_id !== undefined ? { account_id: args.account_id } : {}
  );
  if ("error" in acct) {
    const env: EngageEnvelope = {
      action: "skipped",
      reason: acct.error,
      error: acct.error,
    };
    if ("available_accounts" in acct) env.available_accounts = acct.available_accounts;
    return envelope(env);
  }
  const accountId = acct.accountId;

  // === STEP 0b: HALT-CHECK (D-65/D-66 — NEW in Plan 70-03) ===
  // Even though delegates (send_message/connection/inmail) have their own
  // halt-check, engage must short-circuit FIRST to avoid the getDegreeOnly()
  // getProfile call (a real Unipile API hit) AND to skip the dry-run audit row
  // write. Halted accounts never even reach degree resolution.
  const halt = await readHaltFlag(accountId);
  if (halt) {
    const paramsHash = computeParamsHash({
      tool: "linkedin_engage",
      profile_url_normalized: profileUrlNormalized,
      note: "halted",
    });
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_engage",
      account_id: accountId,
      params_hash: paramsHash,
      result: "error_account_halted",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    log.warn("engage halted (account flag set)", {
      account_id: accountId,
      reason: halt.reason,
      status: halt.status,
      halted_at: halt.halted_at,
    });
    return envelope({
      action: "skipped",
      reason: "error_account_halted",
      error: "error_account_halted",
      degree: null,
      audit_id: auditId,
      halted_at: halt.halted_at,
    });
  }

  // === STEP 1: DRY-RUN early return (D-32/D-33 — BEFORE rate-limit, BEFORE any write) ===
  // D-32 GREP GUARD: `args.dry_run === true` is the operator-observable proof that
  // the dry-run gate runs BEFORE any provider write API call. DO NOT remove or rename.
  if (args.dry_run === true) {
    const dr = await getDegreeOnly(args, accountId);
    if ("error" in dr) {
      // Couldn't even resolve degree — still audit the attempt as dry_run
      // (D-33: bill-of-actions visibility includes failure cases).
      const paramsHash = computeParamsHash({
        tool: "linkedin_engage",
        profile_url_normalized: profileUrlNormalized,
        note: "dry_run",
      });
      await writeAuditRow({
        audit_id: auditId,
        actor_user_id: args.actor_user_id,
        tool: "linkedin_engage",
        account_id: accountId,
        params_hash: paramsHash,
        result: "dry_run",
        verified: false,
        dedup_hit: false,
        timestamp: new Date().toISOString(),
      });
      return envelope({
        action: "dry_run_proposed",
        proposed_action: "skipped",
        dry_run: true,
        degree: null,
        reason: dr.error,
        audit_id: auditId,
      });
    }
    const route = routeFromDegree(dr.degree, args);
    // For BLOCKER-1: `skipped_no_inmail_subject` surfaces as `proposed_action: 'send_inmail'`
    // (the InMail route WOULD fire if a subject were supplied) plus
    // `would_skip_with_reason: 'no_inmail_subject'` (operator hint).
    // H-01: same pattern for `skipped_no_inmail_body` —
    // `would_skip_with_reason: 'no_inmail_body'`.
    const proposedAction: "send_message" | "send_connection" | "send_inmail" | "skipped" =
      route === "send_message"
        ? "send_message"
        : route === "send_connection"
          ? "send_connection"
          : route === "send_inmail" ||
              route === "skipped_no_inmail_subject" ||
              route === "skipped_no_inmail_body"
            ? "send_inmail"
            : "skipped";
    const wouldSkipWithReason =
      route === "skipped_no_inmail_subject"
        ? "no_inmail_subject"
        : route === "skipped_no_inmail_body"
          ? "no_inmail_body"
          : undefined;
    const paramsHash = computeParamsHash({
      tool: "linkedin_engage",
      profile_url_normalized: profileUrlNormalized,
      note: `dry_run:${proposedAction}:${dr.degree ?? "null"}`,
    });
    // D-33: dry_run writes ONE audit row with result: 'dry_run' (no rate-limit incr).
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_engage",
      account_id: accountId,
      params_hash: paramsHash,
      result: "dry_run",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    const env: EngageEnvelope = {
      action: "dry_run_proposed",
      proposed_action: proposedAction,
      dry_run: true,
      degree: dr.degree,
      audit_id: auditId,
    };
    if (route === "skipped_no_message") env.reason = "no_message_provided";
    if (route === "skipped_unreachable") env.reason = "unreachable_no_inmail_fallback";
    if (wouldSkipWithReason) env.would_skip_with_reason = wouldSkipWithReason;
    return envelope(env);
  }

  // === STEP 2: REAL dispatch — resolve degree, then delegate ===
  const dr = await getDegreeOnly(args, accountId);
  if ("error" in dr) {
    log.warn("engage degree-resolution failed", {
      account_id: accountId,
      error: dr.error,
    });
    return envelope({
      action: "skipped",
      reason: dr.error,
      degree: null,
      error: dr.error,
    });
  }
  const degree = dr.degree;
  const route = routeFromDegree(degree, args);

  switch (route) {
    case "send_message": {
      const delegateResult = await handleLinkedinSendMessage({
        profile_url: args.profile_url,
        // route() guarantees args.message is defined here
        text: args.message!,
        account_id: accountId,
        actor_user_id: args.actor_user_id,
        ...(args.crm_log !== undefined ? { crm_log: args.crm_log } : {}),
      });
      const delegateEnv = JSON.parse(delegateResult.content[0]!.text) as Record<string, unknown>;
      return envelope({ action: "sent_message", degree, delegate_envelope: delegateEnv });
    }
    case "send_connection": {
      const delegateResult = await handleLinkedinSendConnection({
        profile_url: args.profile_url,
        ...(args.note !== undefined ? { note: args.note } : {}),
        account_id: accountId,
        actor_user_id: args.actor_user_id,
        ...(args.crm_log !== undefined ? { crm_log: args.crm_log } : {}),
      });
      const delegateEnv = JSON.parse(delegateResult.content[0]!.text) as Record<string, unknown>;
      return envelope({ action: "sent_connection", degree, delegate_envelope: delegateEnv });
    }
    case "send_inmail": {
      // BLOCKER-1 + H-01: routeFromDegree only returns "send_inmail" when:
      //   args.allow_inmail === true AND args.inmail_subject is non-empty
      //   AND args.message is non-empty.
      // Non-null assertions are safe here.
      const delegateResult = await handleLinkedinSendInmail({
        profile_url: args.profile_url,
        text: args.message!,
        subject: args.inmail_subject!,
        allow_inmail: true,
        account_id: accountId,
        actor_user_id: args.actor_user_id,
        ...(args.crm_log !== undefined ? { crm_log: args.crm_log } : {}),
      });
      const delegateEnv = JSON.parse(delegateResult.content[0]!.text) as Record<string, unknown>;
      return envelope({ action: "sent_inmail", degree, delegate_envelope: delegateEnv });
    }
    case "skipped_no_message":
      return envelope({ action: "skipped", reason: "no_message_provided", degree });
    case "skipped_no_inmail_subject":
      // BLOCKER-1: InMail route was chosen but no subject was provided.
      // Mirror skipped_no_message pattern — operator gets actionable feedback.
      return envelope({
        action: "skipped",
        reason: "skipped_no_inmail_subject",
        degree,
      });
    case "skipped_no_inmail_body":
      // H-01: InMail route was chosen but no message body was provided.
      // Avoids dispatching a blank-body paid InMail (LinkedIn either rejects
      // with opaque error OR burns the credit on an empty message).
      return envelope({
        action: "skipped",
        reason: "skipped_no_inmail_body",
        degree,
      });
    case "skipped_unreachable":
      return envelope({
        action: "skipped",
        reason: "unreachable_no_inmail_fallback",
        degree,
      });
  }
}
