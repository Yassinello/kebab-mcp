import { z } from "zod";
import { sendEmail } from "../lib/gmail";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const gmailSendSchema = {
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body (plain text)"),
  cc: z.string().optional().describe("CC recipients (comma-separated)"),
  bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleGmailSend(params: {
  to: string;
  subject: string;
  body: string;
  cc?: string | undefined;
  bcc?: string | undefined;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const result = await sendEmail(r.ctx, {
    to: params.to,
    subject: params.subject,
    body: params.body,
    cc: params.cc,
    bcc: params.bcc,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `Email sent to ${params.to} — id: ${result.id}`,
      },
    ],
  };
}
