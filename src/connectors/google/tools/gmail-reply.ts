import { z } from "zod";
import { replyToEmail } from "../lib/gmail";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const gmailReplySchema = {
  message_id: z
    .string()
    .describe("Message ID of the email to reply to (from gmail_inbox or gmail_read)"),
  body: z.string().describe("Reply body (plain text)"),
  cc: z.string().optional().describe("CC recipients (comma-separated)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleGmailReply(params: {
  message_id: string;
  body: string;
  cc?: string | undefined;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const result = await replyToEmail(r.ctx, {
    messageId: params.message_id,
    body: params.body,
    cc: params.cc,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `Reply sent — id: ${result.id}, thread: ${result.threadId}`,
      },
    ],
  };
}
