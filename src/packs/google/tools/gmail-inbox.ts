import { getInstanceConfig } from "@/core/config";
import { z } from "zod";
import { listEmails } from "../lib/gmail";

export const gmailInboxSchema = {
  max_results: z
    .number()
    .optional()
    .describe("Max emails to return (default: 10, max: 20)"),
  query: z
    .string()
    .optional()
    .describe(
      'Gmail search query. Examples: "is:unread", "from:brevo.com", "subject:invoice newer_than:7d"'
    ),
};

export async function handleGmailInbox(params: {
  max_results?: number;
  query?: string;
}) {
  const emails = await listEmails({
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
