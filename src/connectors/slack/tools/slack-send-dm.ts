import { z } from "zod";
import { resolveUserId, openDmAndSend } from "../lib/slack-api";
import { resolveSlackTokens } from "../lib/resolve-account";

export const slackSendDmSchema = {
  to: z
    .string()
    .describe(
      "Recipient: a Slack user id (U…/W…), an email (resolved via users.lookupByEmail), or a display/real name (resolved via the member roster — must be unambiguous)."
    ),
  text: z.string().describe("Message text (supports Slack markdown)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleSlackSendDm(params: {
  to: string;
  text: string;
  account?: string | undefined;
}) {
  const resolved = await resolveSlackTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const userId = await resolveUserId(resolved.tokens, params.to);
  const result = await openDmAndSend(resolved.tokens, userId, params.text);
  return {
    content: [
      {
        type: "text" as const,
        text: `DM sent to ${userId} in ${result.channel} (ts: ${result.ts})`,
      },
    ],
  };
}
