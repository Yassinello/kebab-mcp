/**
 * whatsapp_read_messages tool — READ-ONLY WhatsApp thread reader.
 *
 * WhatsApp counterpart to linkedin_read_messages. Returns the message
 * history of ONE WhatsApp conversation identified by `chat_id` (from
 * whatsapp_list_inbox). WhatsApp has no public profile URL, so there is no
 * profile_url resolution path — chat_id is the only target.
 *
 * Read-only invariants: NO audit, NO rate-limit, NO dedup, NO CRM bridge.
 *
 * Envelope: {chat_id, count, items: [{message_id, direction: 'in'|'out',
 *   sender_id, text, sent_at, has_attachments}]}, sorted oldest-first.
 * Raw message text IS returned (reading your own inbox is the purpose).
 */

import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getMessagingProvider, type ProviderMessage } from "../provider";
import { resolveAccountIdForType } from "../lib/account";
import { classifyUnipileError } from "../lib/errors";
import { runRead } from "../lib/read-helpers";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";

const log = getLogger("CONNECTOR:unipile");

export const whatsappReadMessagesSchema = {
  chat_id: z
    .string()
    .min(1)
    .describe(
      "Unipile chat_id (from whatsapp_list_inbox). Required — WhatsApp has no profile URL."
    ),
  account_id: z
    .string()
    .optional()
    .describe(
      "Unipile WhatsApp account_id (optional if exactly 1 WhatsApp account connected; required if 0 or ≥2)."
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .default(50)
    .describe("Max messages to return, sorted oldest-first (default 50, cap 200)."),
};

type ReadMessagesArgs = {
  chat_id: string;
  account_id?: string;
  limit?: number;
};

interface ThreadMessage {
  message_id: string;
  direction: "in" | "out";
  sender_id: string | null;
  text: string | null;
  sent_at: string | null;
  has_attachments: boolean;
}

interface ReadMessagesEnvelope {
  chat_id: string | null;
  count: number;
  items: ThreadMessage[];
  error?: string;
  available_accounts?: string[];
}

function envelope(e: ReadMessagesEnvelope): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }] };
}

export async function handleWhatsappReadMessages(args: ReadMessagesArgs): Promise<ToolResult> {
  // runRead converts any throw (account-resolver / getUnipileClient on missing
  // env / stray SDK error) into a {chat_id:null, error} envelope (review HIGH-2).
  return runRead("whatsapp_read_messages", { chat_id: null, count: 0, items: [] }, () =>
    readMessagesBody(args)
  );
}

async function readMessagesBody(args: ReadMessagesArgs): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 50, 200);

  // Account resolution is a guard against a misconfigured instance (0 or ≥2
  // WhatsApp accounts) even though getAllMessagesFromChat is keyed by
  // chat_id — surfacing error_account_id_required is more useful than a
  // bare upstream error if the operator has multiple accounts.
  const acct = await resolveAccountIdForType(
    "WHATSAPP",
    args.account_id !== undefined ? { account_id: args.account_id } : {}
  );
  if ("error" in acct) {
    return envelope({
      chat_id: null,
      count: 0,
      items: [],
      error: acct.error,
      ...(acct.error === "error_account_id_required"
        ? { available_accounts: acct.available_accounts }
        : {}),
    });
  }

  let rawItems: ProviderMessage[];
  try {
    rawItems = await getMessagingProvider().listChatMessages({ chatId: args.chat_id, limit });
  } catch (err) {
    log.warn("whatsapp_read_messages getAllMessagesFromChat failed", {
      chat_id: args.chat_id,
      err: toMsg(err),
    });
    return envelope({
      chat_id: args.chat_id,
      count: 0,
      items: [],
      error: classifyUnipileError(err),
    });
  }

  const shaped: ThreadMessage[] = rawItems
    .map((m) => ({
      message_id: m.id,
      direction: m.direction,
      sender_id: m.senderId,
      text: m.text,
      sent_at: m.sentAt,
      has_attachments: m.hasAttachments,
    }))
    .sort((a, b) => {
      const ta = a.sent_at ? new Date(a.sent_at).getTime() : 0;
      const tb = b.sent_at ? new Date(b.sent_at).getTime() : 0;
      return ta - tb;
    });

  return envelope({ chat_id: args.chat_id, count: shaped.length, items: shaped });
}
