import { z } from "zod";
import { searchMessages } from "../lib/slack-api";
import { resolveSlackTokens } from "../lib/resolve-account";

export const slackSearchSchema = {
  query: z
    .string()
    .describe("Search query (supports Slack search operators: from:, in:, has:, etc.)"),
  count: z.number().optional().describe("Max results (default: 10)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleSlackSearch(params: {
  query: string;
  count?: number | undefined;
  account?: string | undefined;
}) {
  const resolved = await resolveSlackTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const results = await searchMessages(resolved.tokens, params.query, params.count);

  if (results.length === 0) {
    return { content: [{ type: "text" as const, text: "No messages found." }] };
  }

  const lines = results.map((m) => `[${m.date.slice(0, 16)}] #${m.channel} ${m.user}: ${m.text}`);

  return {
    content: [{ type: "text" as const, text: lines.join("\n\n") }],
  };
}
