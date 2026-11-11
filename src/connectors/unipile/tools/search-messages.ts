/**
 * whatsapp_search_messages / linkedin_search_messages — READ.
 *
 * Keyword search over recent messages of one chat or of the whole account.
 * Unipile exposes no full-text search, so Kebab scans a bounded window
 * (≤ MAX_SCAN messages newer than `since_days`) and filters locally:
 * accent/case-insensitive, every query term must appear.
 *
 * Returns raw message text (reading your own inbox is the purpose) as a
 * snippet centred on the hit, plus the chat name when resolvable.
 */

import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { resolveAccountIdForType } from "../lib/account";
import { runRead } from "../lib/read-helpers";
import { accountArg, accountIdField, jsonResult } from "../lib/common-schema";
import { matchesAllTerms, queryTerms, snippet } from "../lib/text-match";
import { getMessagingProvider, type Channel, type ProviderMessage } from "../provider";

export const MAX_SCAN = 1000;

function schemaFor(channel: "LinkedIn" | "WhatsApp") {
  return {
    query: z
      .string()
      .min(2)
      .max(200)
      .describe("Words to find (all must appear; accents/case ignored), e.g. 'vans playa'."),
    chat_id: z
      .string()
      .optional()
      .describe(
        `Restrict to one conversation (chat_id from ${channel.toLowerCase()}_list_inbox or whatsapp_find_chat).`
      ),
    since_days: z
      .number()
      .int()
      .positive()
      .max(365)
      .default(30)
      .describe("Only messages from the last N days (default 30, max 365)."),
    limit: z.number().int().positive().max(100).default(20).describe("Max matches (default 20)."),
    account_id: accountIdField(channel),
  };
}

export const whatsappSearchMessagesSchema = schemaFor("WhatsApp");
export const linkedinSearchMessagesSchema = schemaFor("LinkedIn");

type Args = {
  query: string;
  chat_id?: string;
  since_days?: number;
  limit?: number;
  account_id?: string;
};

async function searchMessages(channel: Channel, tool: string, args: Args): Promise<ToolResult> {
  return runRead(tool, { matches: [], scanned: 0 }, async () => {
    const limit = args.limit ?? 20;
    const sinceDays = args.since_days ?? 30;
    const acct = await resolveAccountIdForType(channel, accountArg(args.account_id));
    if ("error" in acct) {
      return jsonResult({
        matches: [],
        scanned: 0,
        error: acct.error,
        ...("available_accounts" in acct ? { available_accounts: acct.available_accounts } : {}),
      });
    }

    const terms = queryTerms(args.query);
    const afterIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const provider = getMessagingProvider();
    const scanned: ProviderMessage[] = args.chat_id
      ? await provider.listChatMessages({ chatId: args.chat_id, limit: MAX_SCAN, afterIso })
      : await provider.listAccountMessages({
          accountId: acct.accountId,
          limit: MAX_SCAN,
          afterIso,
        });

    const hits = scanned
      .filter((m) => matchesAllTerms(m.text, terms))
      .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))
      .slice(0, limit);

    // Resolve chat names in one call (best-effort).
    const names = new Map<string, string | null>();
    if (hits.length > 0) {
      try {
        const chats = await provider.listChats({
          accountId: acct.accountId,
          channel,
          limit: 200,
        });
        for (const c of chats) names.set(c.id, c.name);
      } catch {
        // names stay unresolved
      }
    }

    return jsonResult({
      matches: hits.map((m) => {
        const chatId = m.chatId ?? args.chat_id ?? null;
        return {
          chat_id: chatId,
          chat_name: chatId ? (names.get(chatId) ?? null) : null,
          message_id: m.id,
          direction: m.direction,
          sender_id: m.senderId,
          text: snippet(m.text ?? "", terms),
          sent_at: m.sentAt,
        };
      }),
      scanned: scanned.length,
      truncated: scanned.length >= MAX_SCAN,
      since: afterIso,
    });
  });
}

export function handleWhatsappSearchMessages(args: Args): Promise<ToolResult> {
  return searchMessages("WHATSAPP", "whatsapp_search_messages", args);
}

export function handleLinkedinSearchMessages(args: Args): Promise<ToolResult> {
  return searchMessages("LINKEDIN", "linkedin_search_messages", args);
}
