import { z } from "zod";
import { sendEmail } from "../lib/gmail";

export const gmailSendSchema = {
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body (plain text)"),
  cc: z.string().optional().describe("CC recipients (comma-separated)"),
  bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
};

export async function handleGmailSend(params: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}) {
  const result = await sendEmail(params);
  return {
    content: [
      {
        type: "text" as const,
        text: `Email sent to ${params.to} — id: ${result.id}`,
      },
    ],
  };
}
