/**
 * Shared write pipeline for the spec-v2 write tools (ADR 0002, spec §4).
 *
 * Every new tool that is visible to other people (WhatsApp message, LinkedIn
 * reply / comment / reaction / post / invitation withdrawal) runs through
 * `runGuardedWrite`, so the safety rules are written — and tested — once:
 *
 *   R2 kill switch → account resolve → prepare (reads only) →
 *   R1 confirm gate (preview, no side effects) → R3 halt flag →
 *   R4 10-min dedup → R5 rate limit → execute → R7 verify → R6 audit
 *
 * Invariants:
 *  - Without `confirm:true` NOTHING is mutated: no audit row, no rate-limit
 *    increment, no provider write. The caller gets a preview to show the user.
 *  - Refusals after the confirm gate write exactly one audit row (hash only,
 *    D-07: the text is never persisted).
 *  - `verified` is strictly boolean (D-13). Never "pending".
 *  - The function never throws: provider failures become `{error}` envelopes.
 */

import { createHash } from "node:crypto";
import { UnsuccessfulRequestError } from "unipile-node-sdk";
import type { ToolResult } from "@/core/types";
import { getContextKVStore } from "@/core/request-context";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
import { resolveAccountIdForType } from "./account";
import { writeAuditRow, generateAuditId, type AuditResult } from "./audit";
import { classifyUnipileError } from "./errors";
import { isChannelWritesDisabled } from "./kill-switch";
import { checkUnipileRateLimit, type UnipileRateLimitedTool } from "./rate-limiter";
import { readHaltFlag } from "../webhook/halt-flag";
import { getMessagingProvider, type Channel } from "../provider";

const log = getLogger("CONNECTOR:unipile");

/** R4: identical (tool, target, content) within this window is not re-sent. */
export const SHORT_DEDUP_WINDOW_SECONDS = 10 * 60;

export interface WriteEnvelope {
  /** true only when the provider write was attempted after confirm:true. */
  executed: boolean;
  /** Present when confirm was not given — exactly what WOULD happen. */
  preview?: Record<string, unknown>;
  confirm_required?: boolean;
  provider_ok: boolean;
  verified: boolean;
  dedup_hit: boolean;
  audit_id?: string;
  error?: string;
  detail?: string;
  available_accounts?: string[];
  blocked_by_rate_limit?: boolean;
  daily_used?: number;
  daily_limit?: number;
  retry_after?: string;
  reason?: string;
  halted_at?: string;
  [extra: string]: unknown;
}

export type PrepareResult =
  | { ok: true; preview: Record<string, unknown> }
  | { ok: false; error: string; detail?: string };

export interface ExecuteResult {
  /** Tool-specific ids surfaced in the envelope (chat_id, message_id, …). */
  fields: Record<string, unknown>;
  verified: boolean;
  /** Recipient provider id recorded on the audit row (webhook correlation). */
  recipientProviderId?: string;
}

export interface GuardedWriteSpec {
  /** Audit `tool` name, e.g. "whatsapp_send_message". */
  tool: string;
  channel: Channel;
  rateKey: UnipileRateLimitedTool;
  accountId: string | undefined;
  actorUserId: string;
  confirm: boolean;
  /** Everything that makes this write distinct (target + content). Hashed, never stored. */
  dedupMaterial: Record<string, unknown>;
  /** Read-only resolution of the target; may refuse pre-flight. */
  prepare: (accountId: string) => Promise<PrepareResult>;
  /** The provider write. Throwing = provider failure (classified + audited). */
  execute: (accountId: string) => Promise<ExecuteResult>;
}

export function envelope(e: WriteEnvelope): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }] };
}

export function hashMaterial(tool: string, material: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries({ tool, ...material }).sort(([a], [b]) => a.localeCompare(b))
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

/**
 * R4 dedup record. `state`:
 *  - "pending"   claimed atomically BEFORE the provider write;
 *  - "done"      provider accepted the write;
 *  - "ambiguous" provider failed in a way that may still have delivered
 *                (5xx / network) — kept so a retry cannot double-send.
 */
interface DedupRecord {
  state: "pending" | "done" | "ambiguous";
  at: number;
  audit_id: string;
  verified: boolean;
}

function dedupKey(hash: string): string {
  return `unipile:dedup-short:${hash}`;
}

/** Fresh = within the window. Age is checked explicitly: the filesystem KV (dev) ignores TTLs. */
function parseFresh(raw: string | null): DedupRecord | null {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as DedupRecord;
    if (typeof rec.at !== "number") return null;
    if (Date.now() - rec.at > SHORT_DEDUP_WINDOW_SECONDS * 1000) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * Atomically claim the dedup slot. Returns the existing fresh record when the
 * slot is taken (→ dedup hit), null when this call now owns it. Uses
 * `setIfNotExists` (Upstash SET NX) so two concurrent identical calls cannot
 * both proceed; falls back to read-then-set on backends without it.
 * A stale record (dev KV without TTL) is overwritten.
 */
async function claimShortDedup(hash: string, rec: DedupRecord): Promise<DedupRecord | null> {
  const kv = getContextKVStore();
  const key = dedupKey(hash);
  const value = JSON.stringify(rec);
  if (typeof kv.setIfNotExists === "function") {
    const res = await kv.setIfNotExists(key, value, { ttlSeconds: SHORT_DEDUP_WINDOW_SECONDS });
    if (res.ok) return null;
    const existing = parseFresh(res.existing);
    if (existing) return existing;
    await kv.set(key, value, SHORT_DEDUP_WINDOW_SECONDS); // stale → take over
    return null;
  }
  const existing = parseFresh(await kv.get(key));
  if (existing) return existing;
  await kv.set(key, value, SHORT_DEDUP_WINDOW_SECONDS);
  return null;
}

async function writeShortDedup(hash: string, rec: DedupRecord): Promise<void> {
  try {
    await getContextKVStore().set(dedupKey(hash), JSON.stringify(rec), SHORT_DEDUP_WINDOW_SECONDS);
  } catch (err) {
    log.warn("short-dedup write failed (non-fatal)", { err: toMsg(err) });
  }
}

async function releaseShortDedup(hash: string): Promise<void> {
  try {
    await getContextKVStore().delete(dedupKey(hash));
  } catch (err) {
    log.warn("short-dedup release failed (non-fatal)", { err: toMsg(err) });
  }
}

/**
 * A failure is "definite" (safe to retry) only when the provider answered
 * with a 4xx — the request was rejected. 5xx, timeouts and network errors may
 * have been delivered upstream.
 */
function isDefiniteFailure(err: unknown): boolean {
  if (!(err instanceof UnsuccessfulRequestError)) return false;
  const status = (err.body as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

export async function runGuardedWrite(spec: GuardedWriteSpec): Promise<ToolResult> {
  // Re-computed with the resolved account once known (dedup is per account).
  let paramsHash = hashMaterial(spec.tool, spec.dedupMaterial);
  const base = { provider_ok: false, verified: false, dedup_hit: false } as const;

  const audit = async (
    auditId: string,
    accountId: string,
    result: AuditResult,
    extra: { verified?: boolean; dedup_hit?: boolean; recipient_provider_id?: string } = {}
  ): Promise<void> => {
    try {
      await writeAuditRow({
        audit_id: auditId,
        actor_user_id: spec.actorUserId,
        tool: spec.tool,
        account_id: accountId,
        params_hash: paramsHash,
        result,
        verified: extra.verified ?? false,
        dedup_hit: extra.dedup_hit ?? false,
        timestamp: new Date().toISOString(),
        ...(extra.recipient_provider_id
          ? { recipient_provider_id: extra.recipient_provider_id }
          : {}),
      });
    } catch (err) {
      // Audit is best-effort AFTER a provider write: never turn a delivered
      // message into a reported failure (the caller would resend).
      log.warn("audit write failed", { tool: spec.tool, err: toMsg(err) });
    }
  };

  /** R6: a confirmed attempt refused before the confirm gate is still audited. */
  const auditRefusal = async (
    accountId: string,
    result: AuditResult
  ): Promise<string | undefined> => {
    if (!spec.confirm) return undefined;
    const id = generateAuditId();
    await audit(id, accountId, result);
    return id;
  };

  try {
    // ── R2 kill switch (before anything else, even preview) ──
    if (isChannelWritesDisabled(spec.channel)) {
      const auditId = await auditRefusal(spec.accountId ?? "", "error_writes_disabled");
      return envelope({
        ...base,
        executed: false,
        error: "error_writes_disabled",
        ...(auditId ? { audit_id: auditId } : {}),
      });
    }

    // ── account resolve ──
    const acct = await resolveAccountIdForType(
      spec.channel,
      spec.accountId !== undefined ? { account_id: spec.accountId } : {}
    );
    if ("error" in acct) {
      const auditId = await auditRefusal(spec.accountId ?? "", "error_account_restricted");
      return envelope({
        ...base,
        executed: false,
        error: acct.error,
        ...(auditId ? { audit_id: auditId } : {}),
        ...(acct.error === "error_account_id_required"
          ? { available_accounts: acct.available_accounts }
          : {}),
      });
    }
    const accountId = acct.accountId;
    paramsHash = hashMaterial(spec.tool, { ...spec.dedupMaterial, account_id: accountId });

    // ── prepare (reads only) ──
    const prep = await spec.prepare(accountId);
    if (!prep.ok) {
      const auditId = await auditRefusal(
        accountId,
        prep.error === "error_attachment_too_large"
          ? "error_attachment_too_large"
          : "error_invalid_request"
      );
      return envelope({
        ...base,
        executed: false,
        error: prep.error,
        ...(auditId ? { audit_id: auditId } : {}),
        ...(prep.detail ? { detail: prep.detail } : {}),
      });
    }

    // ── R1 confirm gate ──
    if (!spec.confirm) {
      return envelope({
        ...base,
        executed: false,
        confirm_required: true,
        preview: { account_id: accountId, ...prep.preview },
        next_step:
          "Show this preview to the user. Only if they explicitly approve, call the same tool again with the same arguments and confirm: true.",
      });
    }

    const auditId = generateAuditId();

    // ── R3 halt flag ──
    const halt = await readHaltFlag(accountId);
    if (halt) {
      await audit(auditId, accountId, "error_account_halted");
      return envelope({
        ...base,
        executed: false,
        audit_id: auditId,
        error: "error_account_halted",
        reason: halt.reason,
        halted_at: halt.halted_at,
      });
    }

    // ── R4 short dedup — atomic claim BEFORE the write ──
    const dup = await claimShortDedup(paramsHash, {
      state: "pending",
      at: Date.now(),
      audit_id: auditId,
      verified: false,
    });
    if (dup) {
      await audit(auditId, accountId, "success", { dedup_hit: true, verified: dup.verified });
      const ago = Math.round((Date.now() - dup.at) / 1000);
      const why =
        dup.state === "done"
          ? `Identical action already executed ${ago}s ago`
          : dup.state === "pending"
            ? `An identical action started ${ago}s ago and is still in progress`
            : `An identical action ${ago}s ago failed with an unknown outcome (it may have been delivered) — check the conversation before retrying`;
      return envelope({
        ...base,
        executed: false,
        verified: dup.verified,
        dedup_hit: true,
        audit_id: auditId,
        detail: `${why} (audit ${dup.audit_id}); not repeated. Change the content or wait ${SHORT_DEDUP_WINDOW_SECONDS / 60} min to send again.`,
      });
    }

    // ── R5 rate limit ──
    const rl = await checkUnipileRateLimit({ account_id: accountId, tool: spec.rateKey });
    if (rl.blocked) {
      await releaseShortDedup(paramsHash); // nothing was sent — free the slot
      await audit(auditId, accountId, "error_rate_limit_kebab");
      log.warn("rate-limit blocked write", {
        tool: spec.tool,
        account_id: accountId,
        daily_used: rl.daily_used,
        daily_limit: rl.daily_limit,
        reason: rl.reason,
      });
      return envelope({
        ...base,
        executed: false,
        audit_id: auditId,
        error: "error_rate_limit_kebab",
        blocked_by_rate_limit: true,
        daily_used: rl.daily_used,
        daily_limit: rl.daily_limit,
        ...(rl.retry_after ? { retry_after: rl.retry_after } : {}),
        ...(rl.reason ? { reason: rl.reason } : {}),
      });
    }

    // ── execute ──
    let res: ExecuteResult;
    try {
      res = await spec.execute(accountId);
    } catch (err) {
      const result = classifyUnipileError(err);
      const definite = isDefiniteFailure(err);
      log.warn("provider write failed", {
        tool: spec.tool,
        account_id: accountId,
        definite,
        err: toMsg(err),
      });
      if (definite) {
        await releaseShortDedup(paramsHash); // rejected upstream — retry allowed
      } else {
        await writeShortDedup(paramsHash, {
          state: "ambiguous",
          at: Date.now(),
          audit_id: auditId,
          verified: false,
        });
      }
      await audit(auditId, accountId, result);
      return envelope({
        ...base,
        executed: true,
        audit_id: auditId,
        error: result,
        ...(definite
          ? {}
          : {
              detail:
                "Outcome unknown: the provider may have delivered it. Check the conversation before retrying; an identical retry is blocked for 10 minutes.",
            }),
      });
    }

    // ── R6 audit + R4 dedup pointer ──
    const result: AuditResult = res.verified ? "success" : "unverified_timeout";
    await writeShortDedup(paramsHash, {
      state: "done",
      at: Date.now(),
      audit_id: auditId,
      verified: res.verified,
    });
    await audit(auditId, accountId, result, {
      verified: res.verified,
      ...(res.recipientProviderId ? { recipient_provider_id: res.recipientProviderId } : {}),
    });

    return envelope({
      executed: true,
      provider_ok: true,
      verified: res.verified,
      dedup_hit: false,
      audit_id: auditId,
      account_id: accountId,
      ...res.fields,
      ...(res.verified ? {} : { error: "unverified_timeout" }),
    });
  } catch (err) {
    // Account resolver / prepare / KV failure before any provider write.
    log.warn("guarded write failed before execute", { tool: spec.tool, err: toMsg(err) });
    return envelope({ ...base, executed: false, error: classifyUnipileError(err) });
  }
}

// ── R7 verify-after-send ──────────────────────────────────────────────────

let verifyDelaysMs: number[] = [3000, 4000];

/** Test-only seam: shorten the verify poll delays. */
export function __setVerifyDelaysForTests(delays: number[] | null): void {
  verifyDelaysMs = delays ?? [3000, 4000];
}

/**
 * Poll the chat (3 s, then 7 s wall-clock) for our outbound message.
 * Match = the returned `messageId`, or any outbound message stamped at/after
 * the request start (2 s skew tolerance). Poll errors are non-fatal (D-16).
 */
export async function verifyOutbound(
  chatId: string,
  requestStartAt: number,
  messageId: string | null
): Promise<boolean> {
  const provider = getMessagingProvider();
  for (const delay of verifyDelaysMs) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const msgs = await provider.listChatMessages({ chatId, limit: 10 });
      const hit = msgs.some(
        (m) =>
          (messageId !== null && m.id === messageId) ||
          (m.direction === "out" &&
            m.sentAt !== null &&
            new Date(m.sentAt).getTime() >= requestStartAt - 2000)
      );
      if (hit) return true;
    } catch (err) {
      log.warn("verifyOutbound poll failed (non-fatal)", { chatId, err: toMsg(err) });
    }
  }
  return false;
}
