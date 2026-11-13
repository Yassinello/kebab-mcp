/**
 * Phase 69 / Plan 04 / Task 1 — linkedin_send_inmail tool (UNI-08).
 *
 * Paid LinkedIn InMail with credit bracketing + Premium gating + explicit-intent
 * `allow_inmail: literal(true)` safety belt.
 *
 * Envelope (D-13/D-14 — LOCKED, `verified` is STRICTLY boolean, NEVER 'pending'):
 *   {
 *     provider_ok: boolean,
 *     verified: boolean,                         // D-13/D-14: strictly boolean
 *     crm_sync: "pending",                       // D-01: hardcoded literal in phase 68/69
 *     dedup_hit: boolean,
 *     audit_id: string,
 *     credits_used: number | null,               // D-28+D-48: null when post-send balance fetch failed
 *     credits_remaining: number | null,
 *     message_id?: string,                       // from startNewChat response
 *     chat_id?: string,
 *     error?: string,                            // any AuditResult enum value
 *     blocked_by_rate_limit?: boolean,
 *     daily_used?: number,
 *     daily_limit?: number,
 *     retry_after?: string,
 *     available_accounts?: string[],             // populated on error_account_id_required (D-20)
 *   }
 *
 * Locked decisions implemented (see .planning/phases/69-linkedin-writes/69-CONTEXT.md):
 *
 *   D-26 — `allow_inmail: z.literal(true)`. The schema literally rejects any
 *     value other than `true`. The handler ALSO defends with an explicit
 *     `args.allow_inmail !== true` check (defense-in-depth: a raw handler call
 *     that bypasses Zod still cannot accidentally burn an InMail credit).
 *
 *   D-27 — `max_inmail_credits?: number` optional cap. Compared against
 *     totalAvailable (sum of premium + recruiter + sales_navigator) BEFORE the
 *     send. If insufficient → `error_inmail_cap_exceeded` (pre-flight refusal,
 *     no rate-limit burn per RESEARCH §4.7).
 *
 *   D-28 — `credits_used` and `credits_remaining` in envelope. Both numeric on
 *     success, or BOTH `null` when the post-send balance fetch fails (the SEND
 *     was successful — we just couldn't measure cost). NEVER throws on
 *     post-send balance failure. AMENDED BY D-48 (next item).
 *
 *   D-29 — Premium gate. If `inmail_balance` returns all three subscription
 *     fields as `null` (no premium tier active) → `error_inmail_requires_premium`
 *     BEFORE the rate-limiter is touched. If a tier is present but `totalAvailable === 0`
 *     (credits exhausted) → also `error_inmail_requires_premium` (operator
 *     experience is identical — go upgrade / refresh credits).
 *
 *   D-48 (amends D-28) — InMail credits are NOT returned by the send call.
 *     Source of truth = `GET /api/v1/linkedin/inmail_balance?account_id=...`
 *     (live-verified). The SDK does NOT expose this endpoint, so we use the
 *     `client.request.send()` escape hatch. The handler brackets the send with
 *     TWO balance reads:
 *       balanceBefore = fetchInmailBalance(accountId)  ← BEFORE the send
 *       startNewChat(...)                              ← the send
 *       balanceAfter  = fetchInmailBalance(accountId)  ← AFTER the send (best-effort)
 *     `credits_used = totalBefore - totalAfter`, `credits_remaining = totalAfter`.
 *     If the AFTER call fails: log warn, return credits=null (send was OK).
 *
 *   D-49 — Handler order (verified WARNING-6 compliant — pre-flight refusals
 *     MUST NOT increment the rate-limit counter per RESEARCH §4.7):
 *       1. allow_inmail-gate (defense-in-depth — Zod already enforces)
 *       2. dedup (first, so re-sends don't burn quota)
 *       3. account-resolve (D-20)
 *       4. balance-before (escape hatch, classify errors)
 *       5. premium-gate (D-29 — no rate-limit touched)
 *       6. cap-gate (D-27 — no rate-limit touched)
 *       7. rate-limit (AFTER all pre-flight refusals)
 *       8. provider-resolve (URN cache + getProfile)
 *       9. CRM outbox
 *      10. SEND via startNewChat with inmail:true (D-50)
 *      11. balance-after (best-effort — credits=null on failure, send is OK)
 *      12. verify = providerOk (planner-discretion per PATTERNS.md L415 —
 *           we skip the 10s message-poll for InMail; the credit was consumed
 *           regardless. Documented for future revisit in phase 71 if
 *           operators report silent InMail failures.)
 *      13. audit row + envelope
 *
 *   D-50 — SDK call is `messaging.startNewChat({account_id, attendees_ids:
 *     [provider_id], subject, text, options: {linkedin: {api: 'classic',
 *     inmail: true}}})`. NOT a separate `users.sendInmail` method (which does
 *     not exist in the SDK).
 *
 * Rate-limiter tool key: 'send_inmail' (daily cap 15 default per D-39, no
 *   weekly cap). Pre-flight refusals (not_authorized, premium_required,
 *   cap_exceeded) are BEFORE the rate-limiter call — tests assert
 *   `rateLimitMock.not.toHaveBeenCalled()` for these paths.
 *
 * Audit (D-25 / D-07 GDPR carry from phase 68): each terminal code path writes
 *   ONE audit row. params_hash includes the text body + subject so a 1-char
 *   edit in either bypasses dedup. Raw text is NEVER persisted — caller (CRM)
 *   owns it.
 *
 * NOTE on `verified = providerOk` (no message-poll for InMail): InMail
 *   delivery to the recipient's InMail tray is async on LinkedIn's side; the
 *   `getAllMessagesFromChat` trick would work but adds 10s latency to EVERY
 *   InMail (which is paid + low-volume). Trade: be optimistic when
 *   provider_ok, since the credit was consumed regardless. If operators
 *   report silent failures in production, add polling in phase 71.
 *
 * NOTE on params_hash composition: `computeParamsHash` accepts only
 *   `{tool, profile_url_normalized, note}` (audit.ts signature, locked in
 *   phase 68 Plan 04). We re-use the `note` slot for the InMail body +
 *   subject — semantically: the user-supplied content that distinguishes
 *   this call from a re-spam. Joining `text` and `subject` into one string
 *   means changing EITHER bypasses dedup (correct semantics).
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
import { crmBridge } from "../lib/crm-bridge";
import { classifyUnipileError } from "../lib/errors";
import { checkUnipileRateLimit } from "../lib/rate-limiter";
import { resolveAccountId } from "../lib/account";
import { readHaltFlag } from "../webhook/halt-flag";
import { isWritesDisabled } from "../lib/kill-switch";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";

const log = getLogger("CONNECTOR:unipile");

export const linkedinSendInmailSchema = {
  profile_url: z
    .string()
    .url()
    .describe(
      "Public LinkedIn profile URL (any degree). InMail can reach out-of-network profiles."
    ),
  text: z.string().min(1).max(8000).describe("InMail body (≤8000 chars)."),
  subject: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "InMail subject line (REQUIRED — InMails support subject lines, unlike standard DMs)."
    ),
  // Single-line for D-26 grep guard: `allow_inmail: z.literal(true)` MUST be on one line.
  // prettier-ignore
  allow_inmail: z.literal(true).describe("REQUIRED: must be exactly true to confirm spending an InMail credit (D-26 safety gate). InMails are paid — credits are derived from premium/sales_navigator/recruiter subscription tiers."),
  max_inmail_credits: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional cap (D-27): refuses with error_inmail_cap_exceeded if the account has fewer credits than this number."
    ),
  preview_id: previewIdField,
  account_id: z
    .string()
    .optional()
    .describe("Unipile LinkedIn account_id (D-20 — optional if exactly 1 LI account)."),
  actor_user_id: z.string().describe("Operator user id. Recorded in audit log."),
  crm_log: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Free-form CRM payload for the outbox row. Phase 70 will POST to UNIPILE_CRM_WEBHOOK_URL."
    ),
};

type SendInmailArgs = {
  profile_url: string;
  text: string;
  subject: string;
  allow_inmail: true;
  max_inmail_credits?: number;
  account_id?: string;
  actor_user_id: string;
  crm_log?: Record<string, unknown>;
};

interface SendInmailEnvelope {
  provider_ok: boolean;
  verified: boolean;
  crm_sync: "pending"; // D-01: hardcoded literal in phase 68/69
  dedup_hit: boolean;
  audit_id: string;
  credits_used: number | null;
  credits_remaining: number | null;
  message_id?: string;
  chat_id?: string;
  error?: string;
  blocked_by_rate_limit?: boolean;
  daily_used?: number;
  daily_limit?: number;
  retry_after?: string;
  available_accounts?: string[]; // populated on error_account_id_required (D-20)
  // === Phase 70 / Plan 70-03 retrofit (D-65/D-66) — halt-flag envelope fields ===
  // Only populated when error === "error_account_halted".
  reason?: string;
  halted_at?: string;
}

function envelope(e: SendInmailEnvelope): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }],
  };
}

/**
 * Shape returned by `GET /linkedin/inmail_balance`. Live-verified 2026-05-18
 * against `api41.unipile.com:17153`. Each field is the credit balance for the
 * corresponding subscription tier, or `null` when the tier is not active on
 * the account.
 */
interface InmailBalance {
  object?: string;
  premium: number | null;
  recruiter: number | null;
  sales_navigator: number | null;
}

/**
 * Total credits available across all subscription tiers. `null` collapses to
 * 0 so the caller can reason about a single scalar.
 */
function totalCredits(b: InmailBalance): number {
  return (b.premium ?? 0) + (b.recruiter ?? 0) + (b.sales_navigator ?? 0);
}

/**
 * D-48 escape hatch — the Unipile SDK does NOT expose a typed
 * `inmail_balance` method, so we go through `client.request.send()` which is
 * the SDK's documented hatch for arbitrary REST endpoints.
 *
 * Wrapped in `withRetry` (D-16) so transient 429/5xx don't surface as a
 * hard failure on the pre-flight balance check.
 */
async function fetchInmailBalance(accountId: string): Promise<InmailBalance> {
  const client = getUnipileClient();
  // The SDK's `request.send` is typed as `unknown`-ish; we cast minimally so
  // TypeScript stays honest about the shape of the body we care about.
  const resp = await withRetry(() =>
    (
      client as unknown as {
        request: {
          send: (i: {
            path: string[];
            method: "GET";
            parameters: Record<string, string>;
          }) => Promise<unknown>;
        };
      }
    ).request.send({
      // SDK RequestInput.path is string[] (joined as "/linkedin/inmail_balance").
      // A plain string here made `path.map` throw → balance pre-flight always failed.
      path: ["linkedin", "inmail_balance"],
      method: "GET",
      parameters: { account_id: accountId },
    })
  );
  return resp as InmailBalance;
}

export async function handleLinkedinSendInmail(args: SendInmailArgs): Promise<ToolResult> {
  const auditId = generateAuditId();

  // Best-effort URL normalization (audit-safe — fall through to raw URL on
  // unsupported shapes so the SDK produces a meaningful error downstream
  // rather than dying here without an audit trail).
  const profileUrlNormalized = (() => {
    try {
      return normalizeProfileUrl(args.profile_url);
    } catch {
      return args.profile_url;
    }
  })();

  // D-25 / D-07 GDPR: text + subject hashed into params_hash (NOT persisted raw).
  // computeParamsHash accepts {tool, profile_url_normalized, note} — we re-use
  // the `note` slot for a joined "subject\ntext" string so EITHER changing
  // bypasses dedup (correct semantics: subject change = new InMail intent).
  const paramsHash = computeParamsHash({
    tool: "linkedin_send_inmail",
    profile_url_normalized: profileUrlNormalized,
    note: `${args.subject}\n${args.text}`,
  });

  // ═══════ Step -1: KILL-SWITCH (D-86/D-88/D-89 — highest-priority gate, NEW in Plan 71-01) ═══════
  // Global kill switch — operator's emergency brake. Reads BEFORE allow_inmail
  // and account-resolve so a halted operator burns nothing (no balance fetch,
  // no SDK call, no audit-only side effects beyond the single refusal row).
  // credits_used/credits_remaining are both null (we never fetched the balance).
  if (isWritesDisabled()) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
      account_id: args.account_id ?? "",
      params_hash: paramsHash,
      result: "error_writes_disabled",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    log.warn("send_inmail refused — KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED");
    return envelope({
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      credits_used: null,
      credits_remaining: null,
      error: "error_writes_disabled",
    });
  }

  // ═══════ Step 1: ALLOW_INMAIL GATE (D-26 — defense-in-depth) ═══════
  // Zod literal(true) already enforces this at the schema layer, but a raw
  // handler invocation (bypassing Zod) must still not accidentally burn a credit.
  if (args.allow_inmail !== true) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
      account_id: args.account_id ?? "unknown",
      params_hash: paramsHash,
      result: "error_inmail_not_authorized",
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
      credits_used: null,
      credits_remaining: null,
      error: "error_inmail_not_authorized",
    });
  }

  // ═══════ Step 2a: ACCOUNT-RESOLVE (D-20 — MOVED UP from Step 3 so halt-check has an accountId) ═══════
  // Phase 70 Plan 70-03 (D-65/D-66): halt-check is the highest-priority gate,
  // BEFORE dedup. Account-resolve must precede halt-check because the halt
  // flag is keyed by account_id. allow_inmail-gate above did not need accountId
  // (cheap arg check), so it stays first — refusing on allow_inmail saves even
  // the account.getAll() call.
  //
  // exactOptionalPropertyTypes: spread only when defined (not as {account_id: undefined}).
  const acct = await resolveAccountId(
    args.account_id !== undefined ? { account_id: args.account_id } : {}
  );
  if ("error" in acct) {
    const result: AuditResult = "error_account_restricted";
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
      account_id: args.account_id ?? "",
      params_hash: paramsHash,
      result,
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    const env: SendInmailEnvelope = {
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      credits_used: null,
      credits_remaining: null,
      error: acct.error,
    };
    if ("available_accounts" in acct) env.available_accounts = acct.available_accounts;
    return envelope(env);
  }
  const accountId = acct.accountId;

  // ═══════ Step 2b: HALT-CHECK (D-65/D-66 — highest-priority gate, NEW in Plan 70-03) ═══════
  // If the account_status webhook handler (Plan 70-02) set a halt flag, refuse
  // immediately. NO dedup check, NO balance fetch, NO rate-limit, NO SDK call.
  // Single minimal audit row. credits_used/credits_remaining are both null
  // (we never fetched the balance).
  const halt = await readHaltFlag(accountId);
  if (halt) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
      account_id: accountId,
      params_hash: paramsHash,
      result: "error_account_halted",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    log.warn("send_inmail halted (account flag set)", {
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
      credits_used: null,
      credits_remaining: null,
      error: "error_account_halted",
      reason: halt.reason,
      halted_at: halt.halted_at,
    });
  }

  // ═══════ Step 3: DEDUP (D-49 — runs AFTER halt-check per D-66) ═══════
  const dup = await checkDedup(paramsHash);
  if (dup) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
      account_id: accountId,
      params_hash: paramsHash,
      result: dup.result,
      verified: dup.verified,
      dedup_hit: true,
      timestamp: new Date().toISOString(),
    });
    return envelope({
      provider_ok: false,
      verified: dup.verified,
      crm_sync: "pending",
      dedup_hit: true,
      audit_id: auditId,
      credits_used: null,
      credits_remaining: null,
    });
  }

  // ═══════ Step 4: BALANCE-BEFORE (D-48 escape hatch) ═══════
  // Classify errors per Wave 1 Plan 01 classifier — 403 inmail_requires_premium
  // maps directly to the same error code as the all-null short-circuit below.
  let balanceBefore: InmailBalance;
  try {
    balanceBefore = await fetchInmailBalance(accountId);
  } catch (err) {
    const result: AuditResult = classifyUnipileError(err);
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
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
      credits_used: null,
      credits_remaining: null,
      error: result,
    });
  }
  const totalBefore = totalCredits(balanceBefore);

  // ═══════ Step 5: PREMIUM GATE (D-29) ═══════
  // Two sub-paths with identical operator-visible outcome but distinct
  // semantics for the credits_used/credits_remaining envelope fields:
  //   - All-null tiers → account has no Premium/Sales-Nav/Recruiter at all.
  //     credits_remaining=0 (we have no idea what they "had" — it's all null).
  //   - Total = 0 with non-null tier → account HAS the tier but credits are
  //     depleted. credits_used=0 (we didn't spend), credits_remaining=0.
  // Both refuse pre-flight with NO rate-limit touched (RESEARCH §4.7).
  if (
    balanceBefore.premium === null &&
    balanceBefore.recruiter === null &&
    balanceBefore.sales_navigator === null
  ) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
      account_id: accountId,
      params_hash: paramsHash,
      result: "error_inmail_requires_premium",
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
      credits_used: null,
      credits_remaining: 0,
      error: "error_inmail_requires_premium",
    });
  }
  if (totalBefore === 0) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
      account_id: accountId,
      params_hash: paramsHash,
      result: "error_inmail_requires_premium",
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
      credits_used: 0,
      credits_remaining: 0,
      error: "error_inmail_requires_premium",
    });
  }

  // ═══════ Step 6: MAX_INMAIL_CREDITS CAP (D-27 — pre-flight refusal) ═══════
  // Semantics per PATTERNS.md L357: refuse if available credits are less than
  // the operator-specified cap (i.e. the cap is a floor for "I need at least
  // this many credits remaining before proceeding"). Pre-flight = NO rate-limit.
  if (args.max_inmail_credits && totalBefore < args.max_inmail_credits) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
      account_id: accountId,
      params_hash: paramsHash,
      result: "error_inmail_cap_exceeded",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    // WARNING-5: audit row has no metadata column — surface cap context in
    // observability log so operators can debug why the call was refused.
    log.warn("InMail cap exceeded", {
      account_id: accountId,
      max_inmail_credits: args.max_inmail_credits,
      totalAvailable: totalBefore,
      would_have_used: 1, // an InMail typically consumes 1 credit
    });
    return envelope({
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      credits_used: 0,
      credits_remaining: totalBefore,
      error: "error_inmail_cap_exceeded",
    });
  }

  // ═══════ Step 7: RATE-LIMIT (AFTER all pre-flight refusals — RESEARCH §4.7) ═══════
  const rl = await checkUnipileRateLimit({ account_id: accountId, tool: "send_inmail" });
  if (rl.blocked) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
      account_id: accountId,
      params_hash: paramsHash,
      result: "error_rate_limit_kebab",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    // WARNING-5: capture cap-context in observability (audit schema has no metadata column).
    log.warn("Rate-limit blocked send_inmail", {
      account_id: accountId,
      tool: "send_inmail",
      daily_used: rl.daily_used,
      daily_limit: rl.daily_limit,
      retry_after: rl.retry_after,
      reason: rl.reason,
    });
    const env: SendInmailEnvelope = {
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      credits_used: 0,
      credits_remaining: totalBefore,
      error: "error_rate_limit_kebab",
      blocked_by_rate_limit: true,
      daily_used: rl.daily_used,
      daily_limit: rl.daily_limit,
    };
    if (rl.retry_after) env.retry_after = rl.retry_after;
    return envelope(env);
  }

  // ═══════ Step 8: RESOLVE PROVIDER_ID ═══════
  // No degree check — InMail is the cross-degree path; refusing on degree
  // would defeat the tool's purpose. Network errors propagate via classifier.
  let providerId: string;
  try {
    const resolved = await resolveProviderId(args.profile_url, accountId);
    providerId = resolved.provider_id;
  } catch (err) {
    const result: AuditResult = classifyUnipileError(err);
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
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
      credits_used: 0,
      credits_remaining: totalBefore,
      error: result,
    });
  }

  // ═══════ Step 9: CRM OUTBOX (D-01 carry — pending row only, no HTTP) ═══════
  await crmBridge.writeOutbox(auditId, { crm_log: args.crm_log ?? null });

  // ═══════ Step 10: SEND via startNewChat with inmail:true (D-50) ═══════
  let chatId: string | null = null;
  let messageId: string | null = null;
  let providerOk = false;
  let sdkError: unknown = null;
  try {
    const resp = await withRetry(() =>
      getUnipileClient().messaging.startNewChat({
        account_id: accountId,
        attendees_ids: [providerId],
        subject: args.subject,
        text: args.text,
        options: { linkedin: { api: "classic", inmail: true } },
      })
    );
    const r = resp as { chat_id?: string | null; message_id?: string | null };
    chatId = r.chat_id ?? null;
    messageId = r.message_id ?? null;
    providerOk = true;
  } catch (err) {
    sdkError = err;
  }

  if (sdkError) {
    const result: AuditResult = classifyUnipileError(sdkError);
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_inmail",
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
      credits_used: 0,
      credits_remaining: totalBefore,
      error: result,
    });
  }

  // ═══════ Step 11: BALANCE-AFTER (D-28 fallback per D-48 — best-effort) ═══════
  // CRITICAL: this call MUST NOT propagate. The SEND already succeeded; the
  // credit was consumed regardless. We log + return credits=null and move on.
  let creditsUsed: number | null = null;
  let creditsRemaining: number | null = null;
  try {
    const balanceAfter = await fetchInmailBalance(accountId);
    const totalAfter = totalCredits(balanceAfter);
    creditsUsed = totalBefore - totalAfter;
    creditsRemaining = totalAfter;
  } catch (err) {
    log.warn("inmail_balance post-send failed (credits=null)", {
      account_id: accountId,
      err: toMsg(err),
    });
  }

  // ═══════ Step 12: VERIFY = providerOk (planner-discretion per PATTERNS.md L415) ═══════
  // We deliberately skip the 10s message-poll for InMail. Rationale:
  //   - InMail delivery is async on LinkedIn's side — the poll trick works
  //     but adds 10s latency to every InMail (paid + low-volume = expensive).
  //   - The credit was consumed regardless of whether the poll succeeds.
  //   - If providerOk=true, the request reached LinkedIn — that IS the
  //     verifiable outcome at this layer.
  // Documented for future revisit in phase 71 if operators report silent
  // InMail failures (e.g. recipient never sees it but credit was spent).
  const verified = providerOk;

  // ═══════ Step 13: AUDIT ROW + ENVELOPE ═══════
  await writeAuditRow({
    audit_id: auditId,
    actor_user_id: args.actor_user_id,
    tool: "linkedin_send_inmail",
    account_id: accountId,
    params_hash: paramsHash,
    result: "success",
    verified,
    dedup_hit: false,
    timestamp: new Date().toISOString(),
  });

  const out: SendInmailEnvelope = {
    provider_ok: providerOk,
    verified,
    crm_sync: "pending",
    dedup_hit: false,
    audit_id: auditId,
    credits_used: creditsUsed,
    credits_remaining: creditsRemaining,
  };
  if (messageId) out.message_id = messageId;
  if (chatId) out.chat_id = chatId;
  return envelope(out);
}
