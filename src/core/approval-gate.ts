/**
 * TRU-04 / audit 2026-11 (A4) — out-of-band approval gate for every outgoing
 * message, shared by all connectors (Gmail, Google Chat, Slack, Unipile…).
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
 * `KEBAB_APPROVAL_MODE=confirm`: the handler is called exactly as before the
 * gate existed (preview_id is ignored).
 *
 * The connector-specific part is a `summarize` function: a read-only
 * description of what will be sent (sending account, recipients, exact
 * text) plus the arguments to store, e.g. with the account pinned.
 * Unipile keeps its own wrappers (src/connectors/unipile/lib/approval-gate.ts)
 * on top of the primitives below.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolResult } from "./types";
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
} from "./approvals";
import { getCallerMeta } from "./token-scope";
import { toMsg } from "./error-utils";

export type GateArgs = Record<string, unknown>;
export type GateHandler = (args: GateArgs) => Promise<ToolResult>;

/** Envelope fields of a call that sent nothing. */
export type NotSentEnvelope = Record<string, unknown>;

/** Default "nothing was sent" envelope for connectors without their own. */
export const DEFAULT_NOT_SENT: NotSentEnvelope = { executed: false };

/** Sentence for the description of a gated send tool. */
export const OUTGOING_APPROVAL_HINT =
  "SAFETY: nothing is sent on the first call — it returns a preview and an approval_url; give that link to the user, and once they approved it call again with preview_id (the approved message is sent exactly as previewed).";

/** TRU-04: id of an approved preview, for the schema of a gated tool. */
export const previewIdSchemaField = z
  .string()
  .max(64)
  .optional()
  .describe(
    "Approval id returned by the preview call. Call again with it once the user has approved the message at approval_url: the approved message stored on the server is sent, other arguments are ignored."
  );

export function gateJsonResult(payload: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

// ── attachments pinning ──────────────────────────────────────────────

export interface AttachmentDigest {
  filename: string;
  mimetype: string;
  bytes: number;
  sha256: string;
}

export function digestAttachments(list: unknown): AttachmentDigest[] {
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

export function gateRefusal(
  error: string,
  detail: string,
  extra: Record<string, unknown> = {},
  notSent: NotSentEnvelope = DEFAULT_NOT_SENT
): ToolResult {
  return gateJsonResult({ ...notSent, error, detail, ...extra });
}

export function readEnvelope(res: ToolResult): Record<string, unknown> | null {
  const first = res.content?.[0];
  if (!first || first.type !== "text") return null;
  try {
    const v = JSON.parse(first.text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Arguments that describe the action (control fields and file bodies removed). */
export function actionArgs(args: GateArgs): GateArgs {
  const out: GateArgs = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "confirm" || k === "preview_id" || k === "attachments" || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function confirmOnlyRefusal(
  tool: string,
  notSent: NotSentEnvelope = DEFAULT_NOT_SENT
): ToolResult {
  return gateRefusal(
    "error_approval_required",
    `confirm:true is not accepted on its own: sends need the user's approval outside the conversation. Call ${tool} without confirm to get a preview and an approval_url, give the link to the user, then call again with the preview_id once they approved it.`,
    {},
    notSent
  );
}

/**
 * Store the exact payload to execute and answer with the preview, the
 * preview id and the signed approval link. Nothing is sent.
 */
export async function offerApproval(opts: {
  tool: string;
  /** Arguments of the previewing call (control fields are dropped). */
  args: GateArgs;
  /** Extra arguments pinned into the stored payload (e.g. the resolved account). */
  pinned?: GateArgs;
  summary: ApprovalSummary;
  base: Record<string, unknown>;
  notSent?: NotSentEnvelope;
}): Promise<ToolResult> {
  const notSent = opts.notSent ?? DEFAULT_NOT_SENT;
  const stored: GateArgs = { ...actionArgs(opts.args), ...(opts.pinned ?? {}) };
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
    return gateRefusal(
      "error_approval_unavailable",
      `Could not create the approval link (${toMsg(err)}). Nothing was sent. Approval links need durable storage (Upstash KV) and a signing secret; an operator may set KEBAB_APPROVAL_MODE=confirm to fall back to in-conversation confirmation.`,
      {},
      notSent
    );
  }
  return gateJsonResult({
    ...opts.base,
    ...notSent,
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
function ignoredArguments(stored: GateArgs, given: GateArgs, pinned: AttachmentDigest[]): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(actionArgs(given))) {
    if (JSON.stringify(v) !== JSON.stringify(stored[k])) out.push(k);
  }
  // Files only travel when the approval pinned them (checked above).
  if (!pinned.length && digestAttachments(given.attachments).length) out.push("attachments");
  return out.sort();
}

/**
 * Execute an approved preview: the STORED arguments, once. Pending, used,
 * expired, rejected or foreign previews are refused and nothing is sent.
 */
export async function executeApproved(
  tool: string,
  previewId: unknown,
  given: GateArgs,
  run: GateHandler,
  notSent: NotSentEnvelope = DEFAULT_NOT_SENT
): Promise<ToolResult> {
  const restart = `Call ${tool} without preview_id to get a new preview and approval link.`;
  if (!isApprovalId(previewId)) {
    return gateRefusal(
      "error_approval_not_found",
      `Unknown or expired preview_id. ${restart}`,
      {},
      notSent
    );
  }
  const rec = await getPreview(previewId);
  if (!rec) {
    return gateRefusal(
      "error_approval_not_found",
      `Unknown or expired preview_id. ${restart}`,
      {},
      notSent
    );
  }
  if (rec.tool !== tool) {
    return gateRefusal(
      "error_approval_tool_mismatch",
      `preview_id ${previewId} was created by ${rec.tool}, not ${tool}. Nothing was sent.`,
      {},
      notSent
    );
  }
  if (rec.status === "pending") {
    const url = await buildApprovalUrl(rec.id);
    return gateRefusal(
      "error_approval_pending",
      `The user has not approved this action yet. Give them the approval link (${url}) and call again with preview_id once they approved it. Nothing was sent.`,
      { approval_url: url, preview_id: rec.id },
      notSent
    );
  }
  if (rec.status === "consumed") {
    return gateRefusal(
      "error_approval_already_used",
      `This approval was already used (each approval executes once). ${restart}`,
      {},
      notSent
    );
  }

  const pinned = Array.isArray(rec.payload.attachments)
    ? (rec.payload.attachments as AttachmentDigest[])
    : [];
  if (pinned.length && !sameDigests(pinned, digestAttachments(given.attachments))) {
    return gateRefusal(
      "error_attachments_mismatch",
      `The approved action carries ${pinned.length} attachment(s) pinned by SHA-256 (${pinned
        .map((a) => a.filename)
        .join(
          ", "
        )}). Files are not stored on the server: resend exactly the same attachments with the preview_id. Nothing was sent.`,
      {},
      notSent
    );
  }

  const taken = await consume(rec.id, tool);
  if (!taken.ok) {
    return gateRefusal(
      taken.reason === "already_consumed"
        ? "error_approval_already_used"
        : "error_approval_not_found",
      taken.reason === "already_consumed"
        ? `This approval was already used (each approval executes once). ${restart}`
        : `Unknown, rejected or expired preview_id. ${restart}`,
      {},
      notSent
    );
  }

  const stored = isRecord(taken.record.payload.args) ? taken.record.payload.args : {};
  const ignored = ignoredArguments(stored, given, pinned);
  const finalArgs: GateArgs = {
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

// ── generic gate for send tools without a preview step of their own ──

/** What a send tool will do, described before anything is sent. */
export interface OutgoingPreview {
  summary: ApprovalSummary;
  /** Shown to the model (and the approve view) as `preview`. Primitives only. */
  preview: Record<string, string | number | boolean | null>;
  /** Arguments pinned into the stored payload (e.g. the resolved account). */
  pinned?: GateArgs;
}

export interface OutgoingGateSpec {
  tool: string;
  /**
   * Read-only: resolve the sending account and recipients and describe the
   * exact message. Return a ToolResult to refuse (returned as is, nothing
   * stored, nothing sent).
   */
  summarize: (args: GateArgs) => Promise<OutgoingPreview | ToolResult>;
}

function isToolResult(v: OutgoingPreview | ToolResult): v is ToolResult {
  return Array.isArray((v as ToolResult).content);
}

/**
 * Wrap a send tool's handler so the message only leaves after the user
 * approved it at the approval link (see the module comment).
 */
export async function gateOutgoingSend(
  spec: OutgoingGateSpec,
  args: GateArgs,
  handler: GateHandler
): Promise<ToolResult> {
  const { preview_id: previewId, confirm, ...rest } = args;
  if (getApprovalMode() === "confirm") return handler(rest);
  if (previewId !== undefined) return executeApproved(spec.tool, previewId, rest, handler);
  if (confirm === true) return confirmOnlyRefusal(spec.tool);

  let described: OutgoingPreview | ToolResult;
  try {
    described = await spec.summarize(rest);
  } catch (err) {
    return gateRefusal(
      "error_preview_failed",
      `Could not prepare the preview (${toMsg(err)}). Nothing was sent.`
    );
  }
  if (isToolResult(described)) return described;
  return offerApproval({
    tool: spec.tool,
    args: rest,
    ...(described.pinned ? { pinned: described.pinned } : {}),
    summary: described.summary,
    base: { preview: described.preview },
  });
}
