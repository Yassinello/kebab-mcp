import { z } from "zod";
import { getAttachment, readEmail } from "../lib/gmail";

export const gmailAttachmentSchema = {
  message_id: z.string().describe("Gmail message ID containing the attachment"),
  attachment_id: z
    .string()
    .optional()
    .describe("Attachment ID (from gmail_read results). If omitted, returns first attachment."),
};

export async function handleGmailAttachment(params: {
  message_id: string;
  attachment_id?: string;
}) {
  let attId = params.attachment_id;

  // If no attachment_id, get the first one from the message
  if (!attId) {
    const email = await readEmail(params.message_id);
    if (email.attachments.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No attachments found on this message." }],
      };
    }
    attId = email.attachments[0].id;
  }

  const att = await getAttachment(params.message_id, attId);

  // Try to decode as text
  const raw = Buffer.from(att.data, "base64url");
  const sizeKB = Math.round(att.size / 1024);

  // If it looks like text (< 100KB and valid UTF-8), return as text
  if (att.size < 100_000) {
    const text = raw.toString("utf-8");
    const isText = !text.includes("\ufffd"); // replacement char = binary
    if (isText) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Attachment (${sizeKB}KB, text):\n\n${text}`,
          },
        ],
      };
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Attachment is binary (${sizeKB}KB). Base64 data available but too large to display. Use gmail_read to see attachment metadata.`,
      },
    ],
  };
}
