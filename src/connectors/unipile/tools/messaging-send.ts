/**
 * whatsapp_send_message + linkedin_reply — WRITE (spec v2 §5).
 *
 * Both run through `runGuardedWrite` (preview unless confirm:true, kill switch,
 * halt flag, 10-min dedup, rate limit, hash-only audit, verify-after-send).
 *
 *  - whatsapp_send_message: target = `chat_id` (existing 1:1 or group) XOR
 *    `phone` (international format; starts or reuses the 1:1 chat with
 *    `<digits>@s.whatsapp.net`). Rate key `whatsapp_send`.
 *  - linkedin_reply: target = `chat_id` of an existing LinkedIn conversation
 *    (any thread: 1st-degree DM, InMail reply, group). Shares the LinkedIn DM
 *    cap (`send_message`) with linkedin_send_message.
 *
 * Pre-flight (prepare) validates the target BEFORE the confirm gate so the
 * preview shows the resolved chat name: a chat that does not exist, belongs to
 * another channel, or to another connected account is refused.
 */

import { z } from "zod";
import type { ToolResult } from "@/core/types";
import {
  attachmentsSchema,
  decodeAttachments,
  LINKEDIN_ATTACHMENT_MIMETYPES,
  WHATSAPP_ATTACHMENT_MIMETYPES,
  type AttachmentInput,
} from "../lib/attachments";
import {
  accountIdField,
  actorUserIdField,
  confirmField,
  previewIdField,
} from "../lib/common-schema";
import { digitsOnly } from "../lib/text-match";
import { envelope, runGuardedWrite, verifyOutbound, type PrepareResult } from "../lib/write-guard";
import {
  getMessagingProvider,
  type Attachment,
  type Channel,
  type ProviderChat,
} from "../provider";

// ── schemas ──

export const whatsappSendMessageSchema = {
  chat_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Existing conversation (1:1 or group) from whatsapp_find_chat / whatsapp_list_inbox. Use this OR phone."
    ),
  phone: z
    .string()
    .min(6)
    .max(32)
    .optional()
    .describe(
      "Recipient phone in international format (e.g. '+33 6 12 34 56 78'). Starts or reuses the 1:1 chat. Use this OR chat_id."
    ),
  text: z.string().min(1).max(4096).describe("Message text (≤4096 chars)."),
  attachments: attachmentsSchema(WHATSAPP_ATTACHMENT_MIMETYPES),
  confirm: confirmField,
  preview_id: previewIdField,
  account_id: accountIdField("WhatsApp"),
  actor_user_id: actorUserIdField,
};

export const linkedinReplySchema = {
  chat_id: z
    .string()
    .min(1)
    .describe(
      "Existing LinkedIn conversation chat_id (from linkedin_list_inbox / linkedin_search_messages)."
    ),
  text: z.string().min(1).max(8000).describe("Reply text (≤8000 chars)."),
  attachments: attachmentsSchema(LINKEDIN_ATTACHMENT_MIMETYPES),
  confirm: confirmField,
  preview_id: previewIdField,
  account_id: accountIdField("LinkedIn"),
  actor_user_id: actorUserIdField,
};

type WhatsappSendArgs = {
  chat_id?: string;
  phone?: string;
  text: string;
  attachments?: AttachmentInput[];
  confirm?: boolean;
  account_id?: string;
  actor_user_id?: string;
};

type LinkedinReplyArgs = {
  chat_id: string;
  text: string;
  attachments?: AttachmentInput[];
  confirm?: boolean;
  account_id?: string;
  actor_user_id?: string;
};

// ── shared helpers ──

/**
 * Validate an existing chat for a send: exists, right channel, right account.
 * Unknown account fields (vendor omitted them) are tolerated.
 */
async function checkChat(
  chatId: string,
  channel: Channel,
  accountId: string
): Promise<{ ok: true; chat: ProviderChat } | { ok: false; error: string; detail?: string }> {
  const chat = await getMessagingProvider().getChat(chatId);
  if (!chat) return { ok: false, error: "error_chat_not_found", detail: `No chat ${chatId}.` };
  if (chat.accountType && chat.accountType.toUpperCase() !== channel) {
    return {
      ok: false,
      error: "error_wrong_channel",
      detail: `Chat ${chatId} is a ${chat.accountType} conversation, not ${channel}.`,
    };
  }
  if (chat.accountId && chat.accountId !== accountId) {
    return {
      ok: false,
      error: "error_chat_account_mismatch",
      detail: `Chat ${chatId} belongs to account ${chat.accountId}; pass account_id: "${chat.accountId}" to send from it.`,
    };
  }
  if (chat.conversationType === "channel") {
    return {
      ok: false,
      error: "error_read_only_chat",
      detail: "WhatsApp channels are broadcast-only; you cannot post in them.",
    };
  }
  return { ok: true, chat };
}

function attachmentNames(list: AttachmentInput[] | undefined): string[] {
  return (list ?? []).map((a) => a.filename);
}

/** International phone → digits, or null when not plausibly E.164. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  let digits = digitsOnly(trimmed);
  if (trimmed.startsWith("00")) digits = digits.slice(2);
  else if (!trimmed.startsWith("+") && digits.startsWith("0")) return null; // national format — ambiguous country
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

// ── whatsapp_send_message ──

export async function handleWhatsappSendMessage(args: WhatsappSendArgs): Promise<ToolResult> {
  const hasChat = typeof args.chat_id === "string" && args.chat_id.length > 0;
  const hasPhone = typeof args.phone === "string" && args.phone.length > 0;
  if (hasChat === hasPhone) {
    return envelope({
      executed: false,
      provider_ok: false,
      verified: false,
      dedup_hit: false,
      error: "error_invalid_request",
      detail: "Provide exactly one of chat_id or phone.",
    });
  }

  const phoneDigits = hasPhone ? normalizePhone(args.phone!) : null;
  let chat: ProviderChat | null = null;
  let attachments: Attachment[] = [];

  return runGuardedWrite({
    tool: "whatsapp_send_message",
    channel: "WHATSAPP",
    rateKey: "whatsapp_send",
    accountId: args.account_id,
    actorUserId: args.actor_user_id ?? "mcp",
    confirm: args.confirm === true,
    dedupMaterial: {
      target: hasChat ? `chat:${args.chat_id}` : `phone:${phoneDigits ?? args.phone}`,
      text: args.text,
      files: attachmentNames(args.attachments),
    },
    prepare: async (accountId): Promise<PrepareResult> => {
      const dec = decodeAttachments(args.attachments);
      if (!dec.ok) return { ok: false, error: dec.error, detail: dec.detail };
      attachments = dec.attachments;

      if (hasPhone) {
        if (!phoneDigits) {
          return {
            ok: false,
            error: "error_invalid_phone",
            detail: "Use international format with country code, e.g. '+33 6 12 34 56 78'.",
          };
        }
        return {
          ok: true,
          preview: {
            channel: "whatsapp",
            to: { phone: `+${phoneDigits}`, chat: "1:1 (started or reused)" },
            text: args.text,
            attachments: attachmentNames(args.attachments),
          },
        };
      }

      const checked = await checkChat(args.chat_id!, "WHATSAPP", accountId);
      if (!checked.ok) return checked;
      chat = checked.chat;
      return {
        ok: true,
        preview: {
          channel: "whatsapp",
          to: { chat_id: chat.id, name: chat.name, conversation_type: chat.conversationType },
          text: args.text,
          attachments: attachmentNames(args.attachments),
        },
      };
    },
    execute: async (accountId) => {
      const provider = getMessagingProvider();
      const startedAt = Date.now();
      if (chat) {
        const { messageId } = await provider.sendToChat({
          chatId: chat.id,
          text: args.text,
          ...(attachments.length ? { attachments } : {}),
        });
        const verified = await verifyOutbound(chat.id, startedAt, messageId);
        return {
          fields: { chat_id: chat.id, chat_name: chat.name, message_id: messageId },
          verified,
          ...(chat.providerId ? { recipientProviderId: chat.providerId } : {}),
        };
      }
      const recipient = `${phoneDigits}@s.whatsapp.net`;
      const { chatId, messageId } = await provider.startChat({
        accountId,
        recipientIds: [recipient],
        text: args.text,
        ...(attachments.length ? { attachments } : {}),
      });
      const verified = chatId ? await verifyOutbound(chatId, startedAt, messageId) : false;
      return {
        fields: { chat_id: chatId, message_id: messageId, phone: `+${phoneDigits}` },
        verified,
        recipientProviderId: recipient,
      };
    },
  });
}

// ── linkedin_reply ──

export async function handleLinkedinReply(args: LinkedinReplyArgs): Promise<ToolResult> {
  let chat: ProviderChat | null = null;
  let attachments: Attachment[] = [];

  return runGuardedWrite({
    tool: "linkedin_reply",
    channel: "LINKEDIN",
    rateKey: "send_message",
    accountId: args.account_id,
    actorUserId: args.actor_user_id ?? "mcp",
    confirm: args.confirm === true,
    dedupMaterial: {
      target: `chat:${args.chat_id}`,
      text: args.text,
      files: attachmentNames(args.attachments),
    },
    prepare: async (accountId): Promise<PrepareResult> => {
      const dec = decodeAttachments(args.attachments);
      if (!dec.ok) return { ok: false, error: dec.error, detail: dec.detail };
      attachments = dec.attachments;
      const checked = await checkChat(args.chat_id, "LINKEDIN", accountId);
      if (!checked.ok) return checked;
      chat = checked.chat;
      return {
        ok: true,
        preview: {
          channel: "linkedin",
          to: { chat_id: chat.id, name: chat.name, conversation_type: chat.conversationType },
          text: args.text,
          attachments: attachmentNames(args.attachments),
        },
      };
    },
    execute: async () => {
      const c = chat!;
      const startedAt = Date.now();
      const { messageId } = await getMessagingProvider().sendToChat({
        chatId: c.id,
        text: args.text,
        ...(attachments.length ? { attachments } : {}),
      });
      const verified = await verifyOutbound(c.id, startedAt, messageId);
      return {
        fields: { chat_id: c.id, chat_name: c.name, message_id: messageId },
        verified,
        ...(c.attendeeProviderId ? { recipientProviderId: c.attendeeProviderId } : {}),
      };
    },
  });
}
