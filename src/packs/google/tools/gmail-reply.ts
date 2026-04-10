import { z } from "zod";
import { replyToEmail } from "../lib/gmail";

export const gmailReplySchema = {
  message_id: z
    .string()
    .describe("Message ID of the email to reply to (from gmail_inbox or gmail_read)"),
  body: z.string().describe("Reply body (plain text)"),
  cc: z.string().optional().describe("CC recipients (comma-separated)"),
};

export async function handleGmailReply(params: { message_id: string; body: string; cc?: string }) {
  const result = await replyToEmail({
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
