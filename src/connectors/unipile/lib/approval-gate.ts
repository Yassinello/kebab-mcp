/**
 * TRU-04 (Kebab House phase 1) — out-of-band approval gate for Unipile writes.
 *
 * Wraps the manifest handlers of every outgoing Unipile action:
 *   - the spec-v2 tools that run through `runGuardedWrite` (their own
 *     `confirm` gate produces the preview), via `gateGuardedWrite`;
 *   - the 4 historical LinkedIn writes (send_connection / send_message /
 *     send_inmail / engage), which had no preview step at all, via
 *     `gateLegacyWrite`.
 *
 * Audit 2026-11 (A4): the link flow itself (store the exact payload, signed
 * approval link, execute the STORED payload once, attachments pinned by
 * SHA-256) now lives in `src/core/approval-gate.ts` and is shared with the
 * Gmail, Google Chat and Slack sends. This module keeps the Unipile-specific
 * parts: its "nothing was sent" envelope, the guarded-preview summary, the
 * kill switch and the account resolution of the historical tools.
 *
 * `KEBAB_APPROVAL_MODE=confirm`: the handlers are called exactly as before
 * this gate existed (preview_id is ignored).
 *
 * The handlers themselves are unchanged: kill switch, halt flag, dedup, rate
 * limit, audit and verify-after-send all still run at execution time.
 */

import type { ToolResult } from "@/core/types";
import { getApprovalMode, type ApprovalSummary } from "@/core/approvals";
import {
  confirmOnlyRefusal as coreConfirmOnlyRefusal,
  executeApproved as coreExecuteApproved,
  gateRefusal,
  isRecord,
  offerApproval as coreOfferApproval,
  readEnvelope,
  type GateArgs,
  type GateHandler,
} from "@/core/approval-gate";
import { toMsg } from "@/core/error-utils";
import { resolveAccountId } from "./account";
import { jsonResult } from "./common-schema";
import { isWritesDisabled } from "./kill-switch";

type Args = GateArgs;
type Handler = GateHandler;

const LINK_HINT =
  "SAFETY: the first call only previews and returns an approval_url; give that link to the user, and after they approve it call again with preview_id (confirm:true alone is refused).";

/**
 * One sentence for tool descriptions, matching the active approval mode.
 * `legacy` tools had no preview step before TRU-04, so in `confirm` mode
 * they keep sending directly and get no hint.
 */
export function approvalHint(opts: { legacy?: boolean } = {}): string {
  if (getApprovalMode() === "link") return LINK_HINT;
  return opts.legacy
    ? ""
    : "SAFETY: preview only unless confirm:true — show the preview and set confirm:true only after the user explicitly approves.";
}

// ── envelopes ────────────────────────────────────────────────────────

const NOT_SENT = { executed: false, provider_ok: false, verified: false, dedup_hit: false };

function refusal(error: string, detail: string, extra: Record<string, unknown> = {}): ToolResult {
  return gateRefusal(error, detail, extra, NOT_SENT);
}

function confirmOnlyRefusal(tool: string): ToolResult {
  return coreConfirmOnlyRefusal(tool, NOT_SENT);
}

function offerApproval(opts: {
  tool: string;
  args: Args;
  accountId: string | undefined;
  summary: ApprovalSummary;
  base: Record<string, unknown>;
}): Promise<ToolResult> {
  return coreOfferApproval({
    tool: opts.tool,
    args: opts.args,
    ...(opts.accountId ? { pinned: { account_id: opts.accountId } } : {}),
    summary: opts.summary,
    base: opts.base,
    notSent: NOT_SENT,
  });
}

function executeApproved(
  tool: string,
  previewId: unknown,
  given: Args,
  run: Handler
): Promise<ToolResult> {
  return coreExecuteApproved(tool, previewId, given, run, NOT_SENT);
}

// ── spec-v2 guarded tools ────────────────────────────────────────────

function describeTarget(preview: Record<string, unknown>): string {
  const to = preview.to;
  if (isRecord(to)) {
    // e.g. "Borderland 2027 (group) · chat 1203…" or "+33612345678 (1:1 (started or reused))"
    const head = [to.name, to.phone].filter((v) => typeof v === "string" && v).join(" ");
    const kind = [to.conversation_type, to.chat].find((v) => typeof v === "string" && v);
    const chatId = typeof to.chat_id === "string" ? `chat ${to.chat_id}` : "";
    const label = [head, kind ? `(${String(kind)})` : ""].filter(Boolean).join(" ");
    return [label, chatId].filter(Boolean).join(" · ") || JSON.stringify(to);
  }
  if (typeof preview.post_id === "string") return `LinkedIn post ${preview.post_id}`;
  if (typeof preview.invitation_id === "string") {
    return `LinkedIn invitation ${preview.invitation_id}`;
  }
  if (preview.action === "publish_post") return "Public LinkedIn post on your profile";
  return "(see details)";
}

function summarizeGuardedPreview(preview: Record<string, unknown>): ApprovalSummary {
  const details: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(preview)) {
    if (k === "account_id" || k === "to" || k === "text") continue;
    if (k === "attachments" && Array.isArray(v) && v.length === 0) continue;
    details[k] = v;
  }
  return {
    account: typeof preview.account_id === "string" ? preview.account_id : null,
    recipient: describeTarget(preview),
    text: typeof preview.text === "string" ? preview.text : null,
    details,
  };
}

/** Gate for a handler built on `runGuardedWrite` (it honours `confirm`). */
export async function gateGuardedWrite(
  tool: string,
  args: Args,
  handler: Handler
): Promise<ToolResult> {
  const { preview_id: previewId, ...rest } = args;
  if (getApprovalMode() === "confirm") return handler(rest);
  if (previewId !== undefined) {
    return executeApproved(tool, previewId, rest, (stored) =>
      handler({ ...stored, confirm: true })
    );
  }
  if (rest.confirm === true) return confirmOnlyRefusal(tool);

  const res = await handler({ ...rest, confirm: false });
  const env = readEnvelope(res);
  const preview = env?.preview;
  // Refusals (kill switch, unknown chat, …) carry no preview: pass through.
  if (!env || env.confirm_required !== true || !isRecord(preview)) return res;
  const { next_step: _n, confirm_required: _c, ...base } = env;
  return offerApproval({
    tool,
    args: rest,
    accountId: typeof preview.account_id === "string" ? preview.account_id : undefined,
    summary: summarizeGuardedPreview(preview),
    base,
  });
}

// ── historical LinkedIn tools ────────────────────────────────────────

export interface LegacyGateSpec {
  tool: string;
  /** Read-only description of what will be sent; may refuse (returned as is). */
  summarize: (args: Args, accountId: string) => Promise<ApprovalSummary | ToolResult>;
  /** Calls that never write (e.g. engage dry_run) bypass the gate. */
  passthrough?: (args: Args) => boolean;
}

function isToolResult(v: ApprovalSummary | ToolResult): v is ToolResult {
  return Array.isArray((v as ToolResult).content);
}

/** Gate for the historical LinkedIn writes (no preview step of their own). */
export async function gateLegacyWrite(
  spec: LegacyGateSpec,
  args: Args,
  handler: Handler
): Promise<ToolResult> {
  const { preview_id: previewId, ...rest } = args;
  if (getApprovalMode() === "confirm") return handler(rest);
  if (spec.passthrough?.(rest)) return handler(rest);
  if (previewId !== undefined) return executeApproved(spec.tool, previewId, rest, handler);
  if (rest.confirm === true) return confirmOnlyRefusal(spec.tool);

  // Same order as the handlers: kill switch, then account resolution.
  if (isWritesDisabled()) {
    return refusal("error_writes_disabled", "LinkedIn writes are disabled by the operator.");
  }
  let accountId: string;
  try {
    const acct = await resolveAccountId(
      typeof rest.account_id === "string" ? { account_id: rest.account_id } : {}
    );
    if ("error" in acct) {
      return jsonResult({
        ...NOT_SENT,
        error: acct.error,
        ...("available_accounts" in acct ? { available_accounts: acct.available_accounts } : {}),
      });
    }
    accountId = acct.accountId;
  } catch (err) {
    return refusal("error_account_resolution_failed", toMsg(err));
  }

  const summary = await spec.summarize(rest, accountId);
  if (isToolResult(summary)) return summary;
  return offerApproval({
    tool: spec.tool,
    args: rest,
    accountId,
    summary,
    base: {
      preview: {
        account_id: accountId,
        to: summary.recipient,
        text: summary.text,
        ...summary.details,
      },
    },
  });
}
