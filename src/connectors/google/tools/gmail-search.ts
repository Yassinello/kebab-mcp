import { getInstanceConfig } from "@/core/config";
import { z } from "zod";
import { searchEmails } from "../lib/gmail";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const gmailSearchSchema = {
  query: z
    .string()
    .describe(
      "Gmail search query. Supports all Gmail operators: from:, to:, subject:, has:attachment, after:2026/01/01, label:, is:starred, newer_than:7d, etc."
    ),
  max_results: z
    .number()
    .optional()
    .describe("Max results (default: 5, max: 10). Each result includes full body."),
  body_mode: z
    .enum(["full", "metadata"])
    .optional()
    .describe(
      "PERF: 'metadata' skips body fetch (~10× smaller payload, no decode). Use when triaging hits before reading. Default: 'full' for back-compat."
    ),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleGmailSearch(params: {
  query: string;
  max_results?: number | undefined;
  body_mode?: "full" | "metadata" | undefined;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const emails = await searchEmails(r.ctx, {
    query: params.query,
    maxResults: params.max_results,
    bodyMode: params.body_mode,
  });

  if (emails.length === 0) {
    return { content: [{ type: "text" as const, text: "No emails found." }] };
  }

  const results = emails.map((e) => {
    const shortDate = new Date(e.date).toLocaleDateString(getInstanceConfig().locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: getInstanceConfig().timezone,
    });
    const attach = e.attachments.length ? ` [${e.attachments.length} attachment(s)]` : "";
    const bodyPreview = e.body.length > 500 ? e.body.slice(0, 500) + "..." : e.body;
    return `[${e.unread ? "UNREAD" : "read"}] ${e.from} — "${e.subject}" — ${shortDate}${attach} (id:${e.id})\n${bodyPreview}`;
  });

  return {
    content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }],
  };
}
