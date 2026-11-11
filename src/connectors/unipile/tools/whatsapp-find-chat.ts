/**
 * whatsapp_find_chat — READ. Find a WhatsApp conversation (group or 1:1) or a
 * contact by name fragment or phone number, to get the `chat_id` the other
 * WhatsApp tools need ("le groupe Borderland" → chat_id).
 *
 * Accent/case-insensitive, all query terms must match. A query with ≥5 digits
 * is also matched against phone numbers (provider ids `<digits>@s.whatsapp.net`).
 * Kebab-side filtering over the most recent `scan_limit` chats / contacts —
 * Unipile has no server-side name search.
 */

import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { resolveAccountIdForType } from "../lib/account";
import { runRead } from "../lib/read-helpers";
import { accountArg, accountIdField, jsonResult } from "../lib/common-schema";
import { digitsOnly, matchesAllTerms, queryTerms } from "../lib/text-match";
import { getMessagingProvider, type ProviderChat, type ProviderContact } from "../provider";

export const whatsappFindChatSchema = {
  query: z
    .string()
    .min(2)
    .max(200)
    .describe(
      "Group / contact name fragment (e.g. 'borderland') or phone number (e.g. '+33 6 12 34 56 78')."
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .default(10)
    .describe("Max chats and contacts returned (default 10)."),
  scan_limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .default(300)
    .describe("How many recent chats/contacts to scan (default 300, max 1000)."),
  include_contacts: z
    .boolean()
    .default(true)
    .describe("Also search the contact list (people you have no recent chat with)."),
  account_id: accountIdField("WhatsApp"),
};

type Args = {
  query: string;
  limit?: number;
  scan_limit?: number;
  include_contacts?: boolean;
  account_id?: string;
};

function phoneOf(providerId: string | null): string | null {
  if (!providerId || !providerId.endsWith("@s.whatsapp.net")) return null;
  const d = digitsOnly(providerId.split("@")[0] ?? "");
  return d ? `+${d}` : null;
}

export async function handleWhatsappFindChat(args: Args): Promise<ToolResult> {
  return runRead("whatsapp_find_chat", { chats: [], contacts: [] }, async () => {
    const limit = args.limit ?? 10;
    const scan = args.scan_limit ?? 300;
    const acct = await resolveAccountIdForType("WHATSAPP", accountArg(args.account_id));
    if ("error" in acct) {
      return jsonResult({
        chats: [],
        contacts: [],
        error: acct.error,
        ...("available_accounts" in acct ? { available_accounts: acct.available_accounts } : {}),
      });
    }

    const terms = queryTerms(args.query);
    // National format ("06 12 …") → drop the trunk 0 so it matches the
    // international provider id ("33612…@s.whatsapp.net").
    const rawDigits = digitsOnly(args.query);
    const qDigits = rawDigits.replace(/^0+/, "");
    const byPhone = qDigits.length >= 5;
    const phoneHit = (...ids: Array<string | null>) =>
      byPhone && ids.some((id) => id !== null && digitsOnly(id).includes(qDigits));

    const provider = getMessagingProvider();
    const chats = await provider.listChats({
      accountId: acct.accountId,
      channel: "WHATSAPP",
      limit: scan,
    });
    const matchedChats = chats
      .filter(
        (c: ProviderChat) =>
          matchesAllTerms(c.name, terms) || phoneHit(c.providerId, c.attendeeProviderId)
      )
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""))
      .slice(0, limit)
      .map((c) => ({
        chat_id: c.id,
        name: c.name,
        conversation_type: c.conversationType,
        provider_id: c.providerId,
        phone: phoneOf(c.providerId) ?? phoneOf(c.attendeeProviderId),
        last_message_at: c.lastMessageAt,
        unread_count: c.unreadCount,
      }));

    let matchedContacts: Array<Record<string, unknown>> = [];
    if (args.include_contacts ?? true) {
      try {
        const contacts = await provider.listContacts({ accountId: acct.accountId, limit: scan });
        matchedContacts = contacts
          .filter(
            (c: ProviderContact) =>
              !c.isSelf && (matchesAllTerms(c.name, terms) || phoneHit(c.providerId))
          )
          .slice(0, limit)
          .map((c) => ({
            contact_id: c.id,
            name: c.name,
            provider_id: c.providerId,
            phone: phoneOf(c.providerId),
          }));
      } catch {
        // Contacts are a best-effort complement; chat matches still useful.
        matchedContacts = [];
      }
    }

    return jsonResult({
      chats: matchedChats,
      contacts: matchedContacts,
      scanned_chats: chats.length,
      hint:
        matchedChats.length === 0 && matchedContacts.length > 0
          ? "No existing chat matched; use whatsapp_send_message with the contact's phone to start one."
          : undefined,
    });
  });
}
