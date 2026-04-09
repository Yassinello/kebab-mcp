import { z } from "zod";
import { createDraft } from "../lib/gmail";

export const gmailDraftSchema = {
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body (plain text)"),
  cc: z.string().optional().describe("CC recipients (comma-separated)"),
  bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
};

export async function handleGmailDraft(params: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}) {
  const result = await createDraft(params);
  return {
    content: [
      {
        type: "text" as const,
        text: `Draft created for ${params.to} — "${params.subject}" (draft_id: ${result.id}). Open Gmail to review and send.`,
      },
    ],
  };
}
