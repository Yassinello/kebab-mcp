import { z } from "zod";
import { readEmail } from "../lib/gmail";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const gmailReadSchema = {
  message_id: z.string().describe("Gmail message ID (from gmail_inbox results)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleGmailRead(params: {
  message_id: string;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const email = await readEmail(r.ctx, params.message_id);

  const attachList = email.attachments.length
    ? `\n\nAttachments (${email.attachments.length}):\n` +
      email.attachments
        .map(
          (a) => `- ${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)}KB, att_id:${a.id})`
        )
        .join("\n")
    : "";

  const text = [
    `From: ${email.from}`,
    `To: ${email.to}`,
    email.cc ? `Cc: ${email.cc}` : null,
    `Subject: ${email.subject}`,
    `Date: ${email.date}`,
    `Status: ${email.unread ? "UNREAD" : "read"}`,
    `Thread: ${email.threadId} | Message-ID: ${email.messageId}`,
    `---`,
    email.body,
    attachList,
  ]
    .filter(Boolean)
    .join("\n");

  return { content: [{ type: "text" as const, text }] };
}
