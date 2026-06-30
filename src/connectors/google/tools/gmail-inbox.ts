import { getInstanceConfig } from "@/core/config";
import { z } from "zod";
import { listEmails } from "../lib/gmail";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const gmailInboxSchema = {
  max_results: z.number().optional().describe("Max emails to return (default: 10, max: 20)"),
  query: z
    .string()
    .optional()
    .describe(
      'Gmail search query. Examples: "is:unread", "from:brevo.com", "subject:invoice newer_than:7d"'
    ),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleGmailInbox(params: {
  max_results?: number | undefined;
  query?: string | undefined;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const emails = await listEmails(r.ctx, {
    maxResults: Math.min(params.max_results || 10, 20),
    query: params.query || "",
  });

  if (emails.length === 0) {
    return { content: [{ type: "text" as const, text: "No emails found." }] };
  }

  const lines = emails.map((e) => {
    const status = e.unread ? "UNREAD" : "read";
    const shortDate = new Date(e.date).toLocaleDateString(getInstanceConfig().locale, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: getInstanceConfig().timezone,
    });
    return `[${status}] ${e.from} — "${e.subject}" — ${shortDate} (id:${e.id})\n  ${e.snippet}`;
  });

  return {
    content: [{ type: "text" as const, text: lines.join("\n\n") }],
  };
}
