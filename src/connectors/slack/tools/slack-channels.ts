import { z } from "zod";
import { listChannels } from "../lib/slack-api";
import { resolveSlackTokens } from "../lib/resolve-account";

export const slackChannelsSchema = {
  limit: z.number().optional().describe("Max channels to return (default: 50)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleSlackChannels(params: {
  limit?: number | undefined;
  account?: string | undefined;
}) {
  const resolved = await resolveSlackTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const channels = await listChannels(resolved.tokens, params.limit);

  if (channels.length === 0) {
    return { content: [{ type: "text" as const, text: "No channels found." }] };
  }

  const lines = channels.map(
    (c) =>
      `${c.isPrivate ? "🔒" : "#"}${c.name} (${c.memberCount} members)${c.topic ? ` — ${c.topic}` : ""}`
  );

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
