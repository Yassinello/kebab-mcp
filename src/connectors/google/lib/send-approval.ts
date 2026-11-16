/**
 * Audit 2026-11 (A4) — out-of-band approval of Google sends (gmail_send,
 * gmail_reply, google_chat_send_message), through the shared gate in
 * src/core/approval-gate.ts.
 *
 * Each `summarize` is read-only: it resolves the sending account (pinned
 * into the stored payload so the approved message leaves from the same
 * account), the recipients and the exact text the user approves.
 */

import type { ToolResult } from "@/core/types";
import type { OutgoingGateSpec, OutgoingPreview } from "@/core/approval-gate";
import { gateRefusal } from "@/core/approval-gate";
import { resolveConnectorAccount } from "@/core/connector-accounts";
import { toMsg } from "@/core/error-utils";
import type { GoogleAuthContext } from "./google-auth";
import { googleFetchJSON } from "./google-fetch";
import { readEmail } from "./gmail";

type Args = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

interface ResolvedGoogleAccount {
  ctx: GoogleAuthContext;
  slug: string;
  /** What the user sees as "From account". */
  label: string;
}

/** Same resolution and messages as resolveGoogleTokens, plus the account's display name. */
async function resolveAccount(args: Args): Promise<ResolvedGoogleAccount | ToolResult> {
  const account = str(args.account) || undefined;
  const r = await resolveConnectorAccount("google", account !== undefined ? { account } : {});
  if ("account" in r) {
    const ctx: GoogleAuthContext = { tokens: r.account.tokens, slug: r.account.slug };
    return { ctx, slug: r.account.slug, label: r.account.name };
  }
  if (r.error === "error_no_account") {
    return textResult(
      "Google pack is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN to your environment variables, or connect an account in /config → Connectors."
    );
  }
  return textResult(
    `Multiple Google accounts are connected. Re-run with the "account" parameter set to one of: ${r.available_accounts.join(", ")}.`
  );
}

function isResult(v: ResolvedGoogleAccount | ToolResult): v is ToolResult {
  return Array.isArray((v as ToolResult).content);
}

/** The mailbox address of the account when Gmail tells it, else the account name. */
async function senderLabel(acct: ResolvedGoogleAccount): Promise<string> {
  try {
    const p = await googleFetchJSON<{ emailAddress?: string }>(
      acct.ctx,
      "https://gmail.googleapis.com/gmail/v1/users/me/profile"
    );
    if (p?.emailAddress) return p.emailAddress;
  } catch {
    // fall back to the account name
  }
  return acct.label;
}

function recipients(to: string, cc: string, bcc: string): string {
  return [to, cc ? `cc: ${cc}` : "", bcc ? `bcc: ${bcc}` : ""].filter(Boolean).join(" · ");
}

export const gmailSendApproval: OutgoingGateSpec = {
  tool: "gmail_send",
  async summarize(args): Promise<OutgoingPreview | ToolResult> {
    const acct = await resolveAccount(args);
    if (isResult(acct)) return acct;
    const from = await senderLabel(acct);
    const to = str(args.to);
    const cc = str(args.cc);
    const bcc = str(args.bcc);
    const subject = str(args.subject);
    const body = str(args.body);
    return {
      summary: {
        account: from,
        recipient: recipients(to, cc, bcc),
        text: body,
        details: {
          subject,
          ...(cc ? { cc } : {}),
          ...(bcc ? { bcc } : {}),
        },
      },
      preview: { from, to, cc: cc || null, bcc: bcc || null, subject, text: body },
      pinned: { account: acct.slug },
    };
  },
};

export const gmailReplyApproval: OutgoingGateSpec = {
  tool: "gmail_reply",
  async summarize(args): Promise<OutgoingPreview | ToolResult> {
    const acct = await resolveAccount(args);
    if (isResult(acct)) return acct;
    const messageId = str(args.message_id);
    let original: Awaited<ReturnType<typeof readEmail>>;
    try {
      original = await readEmail(acct.ctx, messageId);
    } catch (err) {
      return gateRefusal(
        "error_preview_failed",
        `Could not read the email to reply to (${toMsg(err)}). Nothing was sent.`
      );
    }
    const from = await senderLabel(acct);
    const subject = original.subject.startsWith("Re:")
      ? original.subject
      : `Re: ${original.subject}`;
    const cc = str(args.cc);
    const body = str(args.body);
    return {
      summary: {
        account: from,
        recipient: recipients(original.from, cc, ""),
        text: body,
        details: {
          subject,
          in_reply_to: `${original.subject} — from ${original.from}, ${original.date}`,
          ...(cc ? { cc } : {}),
        },
      },
      preview: { from, to: original.from, cc: cc || null, subject, text: body },
      pinned: { account: acct.slug },
    };
  },
};

export const chatSendApproval: OutgoingGateSpec = {
  tool: "google_chat_send_message",
  async summarize(args): Promise<OutgoingPreview | ToolResult> {
    const acct = await resolveAccount(args);
    if (isResult(acct)) return acct;
    const from = await senderLabel(acct);
    const space = str(args.space_name);
    let spaceName = space;
    if (/^spaces\/[A-Za-z0-9_-]{1,100}$/.test(space)) {
      try {
        const s = await googleFetchJSON<{ displayName?: string }>(
          acct.ctx,
          `https://chat.googleapis.com/v1/${space}`
        );
        if (s?.displayName) spaceName = `${s.displayName} (${space})`;
      } catch {
        // keep the resource name
      }
    }
    const text = str(args.text);
    return {
      summary: {
        account: from,
        recipient: `Google Chat: ${spaceName}`,
        text,
        details: { channel: "Google Chat" },
      },
      preview: { from, to: spaceName, text },
      pinned: { account: acct.slug },
    };
  },
};
