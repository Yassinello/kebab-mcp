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
 * `KEBAB_APPROVAL_MODE=link` (default):
 *   1st call (no preview_id) → preview + `preview_id` + signed `approval_url`;
 *     the exact arguments to execute are stored server-side (core/approvals).
 *   `confirm: true` without an approved preview_id → refused, nothing sent.
 *   call with `preview_id` → if the user approved it at the link, the STORED
 *     arguments are executed once (arguments passed by the model on that call
 *     are ignored and listed back); pending / used / expired → refused.
 *   Attachments are not stored (size): they are pinned by SHA-256 and must be
 *   resent byte-identical with the preview_id, or the call is refused.
 *
 * `KEBAB_APPROVAL_MODE=confirm`: the handlers are called exactly as before
 * this gate existed (preview_id is ignored).
 *
 * The handlers themselves are unchanged: kill switch, halt flag, dedup, rate
 * limit, audit and verify-after-send all still run at execution time.
 */

import { createHash } from "node:crypto";
import type { ToolResult } from "@/core/types";
import {
  APPROVAL_TTL_SECONDS,
  buildApprovalUrl,
  consume,
  createPreview,
  getApprovalMode,
  getPreview,
  isApprovalId,
  type ApprovalRecord,
  type ApprovalSummary,
} from "@/core/approvals";
import { getCallerMeta } from "@/core/token-scope";
import { toMsg } from "@/core/error-utils";
import { resolveAccountId } from "./account";
import { jsonResult } from "./common-schema";
import { isWritesDisabled } from "./kill-switch";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<ToolResult>;

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

// ── attachments pinning ──────────────────────────────────────────────

interface AttachmentDigest {
  filename: string;
  mimetype: string;
  bytes: number;
  sha256: string;
}

function digestAttachments(list: unknown): AttachmentDigest[] {
  if (!Array.isArray(list)) return [];
  return list.map((a: { filename?: unknown; mimetype?: unknown; base64?: unknown }) => {
    const buf = Buffer.from(typeof a.base64 === "string" ? a.base64 : "", "base64");
    return {
      filename: String(a.filename ?? ""),
      mimetype: String(a.mimetype ?? ""),
      bytes: buf.byteLength,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  });
}

function sameDigests(a: AttachmentDigest[], b: AttachmentDigest[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.sha256 === b[i]!.sha256 && x.filename === b[i]!.filename && x.mimetype === b[i]!.mimetype
    )
  );
}

// ── envelopes ────────────────────────────────────────────────────────

const NOT_SENT = { executed: false, provider_ok: false, verified: false, dedup_hit: false };

function refusal(error: string, detail: string, extra: Record<string, unknown> = {}): ToolResult {
  return jsonResult({ ...NOT_SENT, error, detail, ...extra });
}

function readEnvelope(res: ToolResult): Record<string, unknown> | null {
  const first = res.content?.[0];
  if (!first || first.type !== "text") return null;
  try {
    const v = JSON.parse(first.text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Arguments that describe the action (control fields and file bodies removed). */
function actionArgs(args: Args): Args {
  const out: Args = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "confirm" || k === "preview_id" || k === "attachments" || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function confirmOnlyRefusal(tool: string): ToolResult {
  return refusal(
    "error_approval_required",
    `confirm:true is not accepted on its own: sends need the user's approval outside the conversation. Call ${tool} without confirm to get a preview and an approval_url, give the link to the user, then call again with the preview_id once they approved it.`
  );
}

async function offerApproval(opts: {
  tool: string;
  args: Args;
  accountId: string | undefined;
  summary: ApprovalSummary;
  base: Record<string, unknown>;
}): Promise<ToolResult> {
  const stored: Args = {
    ...actionArgs(opts.args),
    ...(opts.accountId ? { account_id: opts.accountId } : {}),
  };
  const attachments = digestAttachments(opts.args.attachments);
  const summary: ApprovalSummary = {
    ...opts.summary,
    details: {
      ...opts.summary.details,
      ...(attachments.length
        ? {
            attachments: attachments.map(
              (a) => `${a.filename} (${a.mimetype}, ${a.bytes} bytes, sha256 ${a.sha256})`
            ),
          }
        : {}),
    },
  };
  const meta = getCallerMeta();
  let rec: ApprovalRecord;
  let url: string;
  try {
    rec = await createPreview({
      tool: opts.tool,
      summary,
      payload: { args: stored, attachments },
      requestedBy: meta?.label ?? meta?.tokenId ?? null,
    });
    url = await buildApprovalUrl(rec.id);
  } catch (err) {
    return refusal(
      "error_approval_unavailable",
      `Could not create the approval link (${toMsg(err)}). Nothing was sent. Approval links need durable storage (Upstash KV) and a signing secret; an operator may set KEBAB_APPROVAL_MODE=confirm to fall back to in-conversation confirmation.`
    );
  }
  return jsonResult({
    ...opts.base,
    ...NOT_SENT,
    approval_required: true,
    preview_id: rec.id,
    approval_url: url,
    expires_at: new Date(rec.expiresAt).toISOString(),
    next_step:
      `Nothing was sent. Give the user this approval link so they can check the exact recipient and text and approve it: ${url} . ` +
      `Once the user says they approved it, call ${opts.tool} again with preview_id: "${rec.id}" — the approved payload stored on the server is executed as is (other arguments are ignored). ` +
      `The link works once and expires in ${APPROVAL_TTL_SECONDS / 60} minutes.`,
  });
}

/** Keys whose value on the executing call differs from the approved payload. */
function ignoredArguments(stored: Args, given: Args, pinned: AttachmentDigest[]): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(actionArgs(given))) {
    if (JSON.stringify(v) !== JSON.stringify(stored[k])) out.push(k);
  }
  // Files only travel when the approval pinned them (checked above).
  if (!pinned.length && digestAttachments(given.attachments).length) out.push("attachments");
  return out.sort();
}

async function executeApproved(
  tool: string,
  previewId: unknown,
  given: Args,
  run: Handler
): Promise<ToolResult> {
  const restart = `Call ${tool} without preview_id to get a new preview and approval link.`;
  if (!isApprovalId(previewId)) {
    return refusal("error_approval_not_found", `Unknown or expired preview_id. ${restart}`);
  }
  const rec = await getPreview(previewId);
  if (!rec) {
    return refusal("error_approval_not_found", `Unknown or expired preview_id. ${restart}`);
  }
  if (rec.tool !== tool) {
    return refusal(
      "error_approval_tool_mismatch",
      `preview_id ${previewId} was created by ${rec.tool}, not ${tool}. Nothing was sent.`
    );
  }
  if (rec.status === "pending") {
    const url = await buildApprovalUrl(rec.id);
    return refusal(
      "error_approval_pending",
      `The user has not approved this action yet. Give them the approval link (${url}) and call again with preview_id once they approved it. Nothing was sent.`,
      { approval_url: url, preview_id: rec.id }
    );
  }
  if (rec.status === "consumed") {
    return refusal(
      "error_approval_already_used",
      `This approval was already used (each approval executes once). ${restart}`
    );
  }

  const pinned = Array.isArray(rec.payload.attachments)
    ? (rec.payload.attachments as AttachmentDigest[])
    : [];
  if (pinned.length && !sameDigests(pinned, digestAttachments(given.attachments))) {
    return refusal(
      "error_attachments_mismatch",
      `The approved action carries ${pinned.length} attachment(s) pinned by SHA-256 (${pinned
        .map((a) => a.filename)
        .join(
          ", "
        )}). Files are not stored on the server: resend exactly the same attachments with the preview_id. Nothing was sent.`
    );
  }

  const taken = await consume(rec.id, tool);
  if (!taken.ok) {
    return refusal(
      taken.reason === "already_consumed"
        ? "error_approval_already_used"
        : "error_approval_not_found",
      taken.reason === "already_consumed"
        ? `This approval was already used (each approval executes once). ${restart}`
        : `Unknown, rejected or expired preview_id. ${restart}`
    );
  }

  const stored = isRecord(taken.record.payload.args) ? taken.record.payload.args : {};
  const ignored = ignoredArguments(stored, given, pinned);
  const finalArgs: Args = {
    ...stored,
    ...(pinned.length ? { attachments: given.attachments } : {}),
  };
  const res = await run(finalArgs);

  const env = readEnvelope(res);
  const approval = {
    preview_id: rec.id,
    executed_payload: "stored (as approved by the user)",
    ...(ignored.length
      ? {
          ignored_arguments: ignored,
          notice: `Arguments passed on this call differ from the approved payload and were ignored: ${ignored.join(", ")}. What the user approved is what was executed.`,
        }
      : {}),
  };
  if (!env) {
    return { ...res, content: [...res.content, { type: "text", text: JSON.stringify(approval) }] };
  }
  return {
    ...res,
    content: [{ type: "text", text: JSON.stringify({ ...env, approval }, null, 2) }],
  };
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
