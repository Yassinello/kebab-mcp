/**
 * TRU-04 — approval summaries for the 4 historical LinkedIn write tools.
 * Each `summarize` is read-only (engage runs its own dry_run, which only
 * resolves the recipient's degree and writes its usual `dry_run` audit row).
 */

import type { ApprovalSummary } from "@/core/approvals";
import { handleLinkedinEngage } from "../tools/linkedin-engage";
import type { LegacyGateSpec } from "./approval-gate";

type Args = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function attachmentNames(v: unknown): string[] {
  return Array.isArray(v) ? v.map((a: { filename?: unknown }) => String(a.filename ?? "")) : [];
}

export const sendConnectionApproval: LegacyGateSpec = {
  tool: "linkedin_send_connection",
  summarize: async (args, accountId): Promise<ApprovalSummary> => ({
    account: accountId,
    recipient: String(args.profile_url),
    text: str(args.note),
    details: { channel: "linkedin", action: "connection_request" },
  }),
};

export const sendMessageApproval: LegacyGateSpec = {
  tool: "linkedin_send_message",
  summarize: async (args, accountId): Promise<ApprovalSummary> => ({
    account: accountId,
    recipient: String(args.profile_url),
    text: str(args.text),
    details: {
      channel: "linkedin",
      action: "direct_message",
      ...(attachmentNames(args.attachments).length
        ? { attachment_names: attachmentNames(args.attachments) }
        : {}),
    },
  }),
};

export const sendInmailApproval: LegacyGateSpec = {
  tool: "linkedin_send_inmail",
  summarize: async (args, accountId): Promise<ApprovalSummary> => ({
    account: accountId,
    recipient: String(args.profile_url),
    text: str(args.text),
    details: {
      channel: "linkedin",
      action: "inmail (paid credit)",
      subject: args.subject,
      ...(args.max_inmail_credits !== undefined
        ? { max_inmail_credits: args.max_inmail_credits }
        : {}),
    },
  }),
};

export const engageApproval: LegacyGateSpec = {
  tool: "linkedin_engage",
  passthrough: (args: Args) => args.dry_run === true,
  summarize: async (args, accountId) => {
    const dry = await handleLinkedinEngage({
      ...(args as Parameters<typeof handleLinkedinEngage>[0]),
      account_id: accountId,
      dry_run: true,
    });
    let env: Record<string, unknown>;
    try {
      env = JSON.parse(dry.content[0]?.type === "text" ? dry.content[0].text : "{}") as Record<
        string,
        unknown
      >;
    } catch {
      return dry;
    }
    // Refusals (halted account…) and "nothing would be sent" are returned
    // as is: there is nothing to approve.
    if (env.action !== "dry_run_proposed" || env.proposed_action === "skipped") return dry;
    const proposed = String(env.proposed_action);
    const text =
      proposed === "send_connection"
        ? str(args.note)
        : proposed === "send_message" || proposed === "send_inmail"
          ? str(args.message)
          : null;
    return {
      account: accountId,
      recipient: String(args.profile_url),
      text,
      details: {
        channel: "linkedin",
        proposed_action: proposed,
        degree: env.degree ?? null,
        // Both texts are part of the approved payload: engage picks one by degree.
        ...(str(args.message) ? { message_if_1st_degree: args.message } : {}),
        ...(str(args.note) ? { connection_note_if_2nd_3rd: args.note } : {}),
        ...(proposed === "send_inmail" ? { inmail_subject: args.inmail_subject ?? null } : {}),
        ...(env.would_skip_with_reason
          ? { would_skip_with_reason: env.would_skip_with_reason }
          : {}),
        note: "Engage re-checks the network degree when it runs; the route may change if the relationship changed since this preview.",
      },
    };
  },
};
