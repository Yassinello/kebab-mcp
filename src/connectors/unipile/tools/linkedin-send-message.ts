/**
 * Phase 69 / Plan 03 / Task 1 — linkedin_send_message tool (UNI-07).
 *
 * 1st-degree LinkedIn DM with attachments + verify-after-write polling.
 *
 * Envelope (D-13/D-14 — LOCKED, `verified` is STRICTLY boolean, NEVER 'pending'):
 *   {
 *     provider_ok: boolean,
 *     verified: boolean,                         // D-13/D-15: strictly boolean
 *     crm_sync: "pending",                       // D-01: hardcoded literal in phase 68/69
 *     dedup_hit: boolean,
 *     audit_id: string,
 *     message_id?: string,                       // from startNewChat response
 *     chat_id?: string,
 *     error?: string,                            // any AuditResult enum value
 *     recipient_degree?: 1 | 2 | 3 | null,       // for D-25 audit + degree-1 refusal context
 *     blocked_by_rate_limit?: boolean,           // only set when rate-limit blocks
 *     daily_used?: number,
 *     daily_limit?: number,
 *     retry_after?: string,                      // ISO 8601 of next reset
 *     available_accounts?: string[],             // populated on error_account_id_required (D-20)
 *   }
 *
 * 1st-degree gate (D-22): refuses with `error_not_connected` if the recipient
 *   is NOT a 1st-degree connection. Pre-flight refusal — saves an API call
 *   AND prevents the silent-DM-to-stranger pattern that triggers LinkedIn
 *   account flags faster than any other action.
 *
 * Attachments (D-46 — supersedes D-23 File[]): schema accepts
 *   `{filename, mimetype, base64}` objects. Server-side decode to the
 *   SDK-expected `Array<[filename, Buffer]>` tuple. Per-file ≤15MB hard cap
 *   (`UnipileAttachmentTooLargeError` + audit `result: error_attachment_too_large`).
 *   Max 5 files, mimetype enum: PDF / PNG / JPEG / GIF.
 *
 * Verify-after-write (D-47 — REPLACES the never-existed `getProfile.last_message_at`):
 *   poll `messaging.getAllMessagesFromChat({chat_id, limit: 5})` at 5s + 10s
 *   wall-clock. `verified: true` if any item has `is_sender === 1` AND
 *   `new Date(timestamp).getTime() >= requestStartAt`. Else `verified: false`.
 *   If `startNewChat` returns `chat_id: null` → skip polling, `verified: false`.
 *
 * Handler order (D-49 + WARNING-6 fix per RESEARCH §4.7 — pre-flight refusals
 *   MUST NOT increment the rate-limit counter):
 *     1. dedup
 *     2. account-resolve
 *     3. attachment-decode (pre-flight)
 *     4. degree-check (pre-flight)
 *     5. rate-limit
 *     6. CRM outbox
 *     7. send (startNewChat)
 *     8. verify (2 polls)
 *     9. audit row + envelope
 *
 * Audit (D-25 / D-07 GDPR carry from phase 68): each terminal code path writes
 *   ONE audit row. params_hash includes the text body so a 1-char edit bypasses
 *   dedup (D-05 design). Raw text is NEVER persisted — caller (CRM) owns it.
 *
 * Rate-limiter tool key: 'send_message' (daily cap 50 default per D-39, no
 *   weekly cap). Pre-flight refusals (attachment-too-large, degree !== 1)
 *   are BEFORE the rate-limiter call — tests assert
 *   `rateLimitMock.not.toHaveBeenCalled()` for these paths.
 *
 * SDK: uses `messaging.startNewChat` (NOT `sendMessage`) per RESEARCH §1 —
 *   the same method works for new AND existing chats (server-side reuse).
 *
 * NOTE on params_hash composition: `computeParamsHash` accepts only
 *   `{tool, profile_url_normalized, note}` (audit.ts signature, locked in
 *   phase 68 Plan 04). We re-use the `note` slot for the message body, same
 *   trick PATTERNS.md line 200 documents — the function name says `note` but
 *   semantically it's "the user-supplied content that distinguishes this
 *   call from a re-spam". Changing 1 char in `text` produces a new hash =
 *   dedup-bypass allowed.
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
import { classifyUnipileError, UnipileAttachmentTooLargeError } from "../lib/errors";
import { checkUnipileRateLimit } from "../lib/rate-limiter";
import { resolveAccountId } from "../lib/account";
import { readHaltFlag } from "../webhook/halt-flag";
import { isWritesDisabled } from "../lib/kill-switch";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";

const log = getLogger("CONNECTOR:unipile");

/** Per-attachment hard limit (D-23 — LinkedIn server-side cap). */
const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024; // 15 MB

export const linkedinSendMessageSchema = {
  profile_url: z
    .string()
    .url()
    .describe(
      "Public LinkedIn profile URL of a 1st-degree connection. Refuses with error_not_connected if recipient is 2nd/3rd degree (D-22)."
    ),
  text: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "Message body (≤8000 chars). Hashed into params_hash for dedup — 1-char change bypasses dedup (D-05)."
    ),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        mimetype: z.enum(["application/pdf", "image/png", "image/jpeg", "image/gif"]),
        base64: z.string().min(1),
      })
    )
    .max(5)
    .optional()
    .describe(
      "Optional attachments. Decoded server-side from base64 to [filename, Buffer] tuples (D-46). Per-file ≤15MB hard cap. Max 5 files."
    ),
  preview_id: previewIdField,
  account_id: z
    .string()
    .optional()
    .describe(
      "Unipile LinkedIn account_id. Optional — if exactly one LinkedIn account is connected, used silently (D-20)."
    ),
  actor_user_id: z.string().describe("Operator user id. Recorded in audit log."),
  crm_log: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Free-form CRM payload for the outbox row. Phase 70 will POST to UNIPILE_CRM_WEBHOOK_URL."
    ),
};

type SendMessageArgs = {
  profile_url: string;
  text: string;
  attachments?: Array<{ filename: string; mimetype: string; base64: string }>;
  account_id?: string;
  actor_user_id: string;
  crm_log?: Record<string, unknown>;
};

interface SendMessageEnvelope {
  provider_ok: boolean;
  verified: boolean;
  crm_sync: "pending"; // D-01: hardcoded literal in phase 68/69
  dedup_hit: boolean;
  audit_id: string;
  message_id?: string;
  chat_id?: string;
  error?: string;
  recipient_degree?: 1 | 2 | 3 | null;
  // Rate-limit block fields (set only when blocked_by_rate_limit: true)
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

function envelope(e: SendMessageEnvelope): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }],
  };
}

/**
 * D-47 verify-after-write: poll the chat's messages at successive `delaysMs`
 * intervals (DELTAS, not absolute timestamps). `[5000, 5000]` yields polls
 * at 5s + 10s wall-clock from invocation.
 *
 * Returns true if any returned item is from the operator
 * (`is_sender === 1`) AND its `timestamp` is at or after `requestStartAt`
 * (epoch ms). Else false.
 *
 * D-16 transient handling: errors during a poll are NON-fatal — we log warn
 * and continue to the next delay. Bounded poll budget keeps worst-case
 * wall-clock inside Vercel's 60s lambda window.
 */
async function pollForMessage(
  chatId: string,
  requestStartAt: number,
  delaysMs: number[]
): Promise<boolean> {
  const client = getUnipileClient();
  for (const delay of delaysMs) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const resp = await client.messaging.getAllMessagesFromChat({
        chat_id: chatId,
        limit: 5,
      });
      const items =
        (resp as { items?: Array<{ is_sender?: number; timestamp?: string }> }).items ?? [];
      const hit = items.some(
        (m) =>
          m.is_sender === 1 &&
          m.timestamp !== undefined &&
          new Date(m.timestamp).getTime() >= requestStartAt
      );
      if (hit) return true;
    } catch (err) {
      // D-16 transient — continue to next delay rather than fail-open with `verified: true`.
      log.warn("pollForMessage transient error", {
        chatId,
        delay,
        err: toMsg(err),
      });
    }
  }
  return false;
}

/**
 * Map Unipile's `network_distance` field (multiple historical spellings) onto
 * the locked 1/2/3 ordinal used in the envelope + audit row. Anything not
 * matching a known 1st/2nd/3rd-degree label collapses to `null` so the
 * D-22 gate refuses safely (we only send when EXACTLY known-1st-degree).
 */
function distanceToDegree(distance: string | undefined): 1 | 2 | 3 | null {
  if (distance === "FIRST_DEGREE" || distance === "DISTANCE_1") return 1;
  if (distance === "SECOND_DEGREE" || distance === "DISTANCE_2") return 2;
  if (distance === "THIRD_DEGREE" || distance === "DISTANCE_3") return 3;
  return null;
}

export async function handleLinkedinSendMessage(args: SendMessageArgs): Promise<ToolResult> {
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

  // D-25 / D-07 GDPR: text hashed into params_hash (NOT persisted raw).
  // computeParamsHash accepts {tool, profile_url_normalized, note} — we
  // re-use the `note` slot for the message body (semantically: the
  // user-supplied content that distinguishes this call from re-spam).
  const paramsHash = computeParamsHash({
    tool: "linkedin_send_message",
    profile_url_normalized: profileUrlNormalized,
    note: args.text,
  });

  // ═══════ Step -1: KILL-SWITCH (D-86/D-88/D-89 — highest-priority gate, NEW in Plan 71-01) ═══════
  // Global kill switch — operator's emergency brake. Reads BEFORE account-resolve
  // so we don't burn a Unipile API call enumerating accounts when writes are
  // globally disabled. NO accountId is known yet — the audit row's account_id
  // field stays "" (D-20 account-resolve error path precedent).
  if (isWritesDisabled()) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_message",
      account_id: args.account_id ?? "",
      params_hash: paramsHash,
      result: "error_writes_disabled",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    log.warn("send_message refused — KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED");
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
  // with no provider write side-effects and no rate-limit cost.
  //
  // Note on `exactOptionalPropertyTypes: true`: only pass `account_id` when
  // defined, never as `undefined` (the helper's ResolveArgs declares it optional,
  // not optional-undefined).
  const acct = await resolveAccountId(
    args.account_id !== undefined ? { account_id: args.account_id } : {}
  );
  if ("error" in acct) {
    // D-20 errors classify as 'restricted' in the audit enum (operator
    // misconfigured their Unipile wiring — same treatment as send-connection).
    const result: AuditResult = "error_account_restricted";
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_message",
      account_id: args.account_id ?? "",
      params_hash: paramsHash,
      result,
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    const env: SendMessageEnvelope = {
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
      tool: "linkedin_send_message",
      account_id: accountId,
      params_hash: paramsHash,
      result: "error_account_halted",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    log.warn("send_message halted (account flag set)", {
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

  // ═══════ Step 1: DEDUP (D-49 — runs AFTER halt-check per D-66) ═══════
  const dup = await checkDedup(paramsHash);
  if (dup) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_message",
      account_id: accountId,
      params_hash: paramsHash,
      result: dup.result, // mirror prior result for trace continuity
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
    });
  }

  // ═══════ Step 3: ATTACHMENT-DECODE (D-46 — pre-flight, BEFORE rate-limit per WARNING-6) ═══════
  let attachmentTuples: Array<[string, Buffer]> | undefined;
  if (args.attachments?.length) {
    try {
      attachmentTuples = args.attachments.map((a) => {
        const buf = Buffer.from(a.base64, "base64");
        if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
          throw new UnipileAttachmentTooLargeError(
            `Attachment ${a.filename} exceeds 15MB`,
            buf.byteLength
          );
        }
        return [a.filename, buf] as [string, Buffer];
      });
    } catch (err) {
      // Pre-flight refusal — does NOT count toward rate-limit (RESEARCH §4.7).
      // Audit row written; rate-limit deliberately not yet called.
      const result: AuditResult = "error_attachment_too_large";
      log.warn("Attachment rejected pre-flight", {
        account_id: accountId,
        err: toMsg(err),
      });
      await writeAuditRow({
        audit_id: auditId,
        actor_user_id: args.actor_user_id,
        tool: "linkedin_send_message",
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
  }

  // ═══════ Step 4: DEGREE-CHECK (D-22 — pre-flight, BEFORE rate-limit per WARNING-6) ═══════
  let providerId: string;
  // M-05: initialize to null. The try/catch below returns early on failure so
  // the success path is correct today, but a future refactor that moves rate-limit
  // (or any other gate) above the degree-fetch would read an uninitialized
  // binding. Belt-and-braces — TS allows this idiom AND we get a safe default
  // (the downstream D-22 check treats null the same as a sub-1st-degree value:
  // refuses to send, which is the correct fail-safe).
  //
  // ESLint complains \`no-useless-assignment\` because the initializer is
  // overwritten on the only currently-reachable success path before being
  // read. That is precisely the point — the initializer protects against
  // FUTURE reachable read paths that don't exist today. Disable the rule
  // here only.
  // eslint-disable-next-line no-useless-assignment
  let degree: 1 | 2 | 3 | null = null;
  try {
    const resolved = await resolveProviderId(args.profile_url, accountId);
    providerId = resolved.provider_id;

    // Fetch the profile explicitly to read network_distance — resolveProviderId
    // only returns provider_id (the cached URN). The slug derivation mirrors
    // identifiers.ts:145 — normalizeProfileUrl strips the trailing slash so
    // we don't need the .replace(/\/$/, "") guard here.
    const slug = profileUrlNormalized.replace(/^https?:\/\/linkedin\.com\/in\//, "");
    const profile = (await withRetry(() =>
      getUnipileClient().users.getProfile({ account_id: accountId, identifier: slug })
    )) as { network_distance?: string };
    degree = distanceToDegree(profile.network_distance);

    if (degree !== 1) {
      // Pre-flight refusal (D-22) — rate-limiter NOT called per RESEARCH §4.7.
      await writeAuditRow({
        audit_id: auditId,
        actor_user_id: args.actor_user_id,
        tool: "linkedin_send_message",
        account_id: accountId,
        params_hash: paramsHash,
        result: "error_not_connected",
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
        error: "error_not_connected",
        recipient_degree: degree,
      });
    }
  } catch (err) {
    // Profile fetch / URN resolve failure → classify, audit, surface.
    // This IS counted as a "real attempt" upstream — but we have not yet
    // hit the rate-limiter, which is fine: we did not actually send.
    const result: AuditResult = classifyUnipileError(err);
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_message",
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

  // ═══════ Step 5: RATE-LIMIT (WARNING-6 retrofit — AFTER all pre-flight refusals) ═══════
  const rl = await checkUnipileRateLimit({ account_id: accountId, tool: "send_message" });
  if (rl.blocked) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_message",
      account_id: accountId,
      params_hash: paramsHash,
      result: "error_rate_limit_kebab",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    // WARNING-5: capture cap-context in observability (audit schema has no metadata column)
    log.warn("Rate-limit blocked send_message", {
      account_id: accountId,
      tool: "send_message",
      daily_used: rl.daily_used,
      daily_limit: rl.daily_limit,
      retry_after: rl.retry_after,
      reason: rl.reason,
    });
    const env: SendMessageEnvelope = {
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      error: "error_rate_limit_kebab",
      blocked_by_rate_limit: true,
      daily_used: rl.daily_used,
      daily_limit: rl.daily_limit,
      recipient_degree: degree,
    };
    if (rl.retry_after) env.retry_after = rl.retry_after;
    return envelope(env);
  }

  // ═══════ Step 6: CRM OUTBOX (D-01 carry — pending row only, no HTTP) ═══════
  await crmBridge.writeOutbox(auditId, { crm_log: args.crm_log ?? null });

  // ═══════ Step 7: SEND via startNewChat (RESEARCH §1 — works for new + existing chats) ═══════
  let chatId: string | null = null;
  let messageId: string | null = null;
  let providerOk = false;
  let sdkError: unknown = null;
  const requestStartAt = Date.now();
  try {
    const resp = await withRetry(() =>
      getUnipileClient().messaging.startNewChat({
        account_id: accountId,
        text: args.text,
        attendees_ids: [providerId],
        ...(attachmentTuples ? { attachments: attachmentTuples } : {}),
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
      tool: "linkedin_send_message",
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
      recipient_degree: degree,
    });
  }

  // ═══════ Step 8: VERIFY-AFTER-WRITE (D-47 — 2 polls at 5s + 10s) ═══════
  // delaysMs is an array of DELTAS; [5000, 5000] = polls at 5s + 10s wall-clock.
  // If chat_id came back null, skip polling — verified stays false (D-13 strict).
  let verified = false;
  if (chatId) {
    verified = await pollForMessage(chatId, requestStartAt, [5000, 5000]);
  }
  const result: AuditResult = verified ? "success" : "unverified_timeout";

  // ═══════ Step 9: AUDIT ROW + ENVELOPE ═══════
  await writeAuditRow({
    audit_id: auditId,
    actor_user_id: args.actor_user_id,
    tool: "linkedin_send_message",
    account_id: accountId,
    params_hash: paramsHash,
    result,
    verified,
    dedup_hit: false,
    timestamp: new Date().toISOString(),
  });

  const out: SendMessageEnvelope = {
    provider_ok: providerOk,
    verified,
    crm_sync: "pending",
    dedup_hit: false,
    audit_id: auditId,
    recipient_degree: degree,
  };
  if (messageId) out.message_id = messageId;
  if (chatId) out.chat_id = chatId;
  if (!verified) out.error = "unverified_timeout";
  return envelope(out);
}
