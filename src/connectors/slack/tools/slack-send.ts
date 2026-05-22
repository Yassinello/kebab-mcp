import { z } from "zod";
import { sendMessage } from "../lib/slack-api";
import { resolveSlackTokens } from "../lib/resolve-account";

export const slackSendSchema = {
  channel: z.string().describe("Channel ID to send to (e.g., C01ABCDEF)"),
  text: z.string().describe("Message text (supports Slack markdown)"),
  thread_ts: z
    .string()
    .optional()
    .describe("Thread timestamp to reply to (makes it a threaded reply)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleSlackSend(params: {
  channel: string;
  text: string;
  thread_ts?: string | undefined;
  account?: string | undefined;
}) {
  const resolved = await resolveSlackTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const result = await sendMessage(resolved.tokens, params.channel, params.text, params.thread_ts);
  return {
    content: [
      {
        type: "text" as const,
        text: `Message sent to ${result.channel} (ts: ${result.ts})`,
      },
    ],
  };
}
