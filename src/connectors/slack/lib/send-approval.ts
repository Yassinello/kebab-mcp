/**
 * Audit 2026-11 (A4) — out-of-band approval of Slack sends (slack_send,
 * slack_send_dm), through the shared gate in src/core/approval-gate.ts.
 *
 * `summarize` is read-only: it resolves the workspace account (pinned into
 * the stored payload) and, for a DM, the recipient's user id (pinned too,
 * so the approved message goes to exactly the person the user saw).
 */

import type { ToolResult } from "@/core/types";
import type { OutgoingGateSpec, OutgoingPreview } from "@/core/approval-gate";
import { gateRefusal } from "@/core/approval-gate";
import { resolveConnectorAccount, type AccountTokenSet } from "@/core/connector-accounts";
import { toMsg } from "@/core/error-utils";
import { resolveUserId } from "./slack-api";

type Args = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

interface ResolvedSlackAccount {
  tokens: AccountTokenSet;
  slug: string;
  name: string;
}

/** Same resolution and messages as resolveSlackTokens, plus the workspace name. */
async function resolveAccount(args: Args): Promise<ResolvedSlackAccount | ToolResult> {
  const account = str(args.account) || undefined;
  const r = await resolveConnectorAccount("slack", account !== undefined ? { account } : {});
  if ("account" in r) {
    return { tokens: r.account.tokens, slug: r.account.slug, name: r.account.name };
  }
  if (r.error === "error_no_account") {
    return textResult(
      "Slack pack is not configured. Add SLACK_BOT_TOKEN to your environment variables."
    );
  }
  return textResult(
    `Multiple Slack accounts are connected. Re-run with the "account" parameter set to one of: ${r.available_accounts.join(", ")}.`
  );
}

function isResult(v: ResolvedSlackAccount | ToolResult): v is ToolResult {
  return Array.isArray((v as ToolResult).content);
}

function workspaceLabel(acct: ResolvedSlackAccount): string {
  return acct.name === "default" ? "Slack (default workspace)" : `Slack: ${acct.name}`;
}

export const slackSendApproval: OutgoingGateSpec = {
  tool: "slack_send",
  async summarize(args): Promise<OutgoingPreview | ToolResult> {
    const acct = await resolveAccount(args);
    if (isResult(acct)) return acct;
    const channel = str(args.channel);
    const threadTs = str(args.thread_ts);
    const text = str(args.text);
    const from = workspaceLabel(acct);
    return {
      summary: {
        account: from,
        recipient: threadTs
          ? `channel ${channel} (reply in thread ${threadTs})`
          : `channel ${channel}`,
        text,
        details: { channel, ...(threadTs ? { thread: threadTs } : {}) },
      },
      preview: { from, to: channel, thread_ts: threadTs || null, text },
      pinned: { account: acct.slug },
    };
  },
};

export const slackSendDmApproval: OutgoingGateSpec = {
  tool: "slack_send_dm",
  async summarize(args): Promise<OutgoingPreview | ToolResult> {
    const acct = await resolveAccount(args);
    if (isResult(acct)) return acct;
    const target = str(args.to);
    let userId: string;
    try {
      userId = await resolveUserId(acct.tokens, target);
    } catch (err) {
      return gateRefusal(
        "error_recipient_not_found",
        `Could not find the Slack person "${target}" (${toMsg(err)}). Nothing was sent.`
      );
    }
    const text = str(args.text);
    const from = workspaceLabel(acct);
    const who = userId === target ? userId : `${target} (${userId})`;
    return {
      summary: {
        account: from,
        recipient: `direct message to ${who}`,
        text,
        details: { channel: "Slack direct message" },
      },
      preview: { from, to: who, text },
      // The approved message goes to the person resolved here.
      pinned: { account: acct.slug, to: userId },
    };
  },
};
