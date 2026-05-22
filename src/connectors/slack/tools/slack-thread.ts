import { z } from "zod";
import { readThread } from "../lib/slack-api";
import { resolveSlackTokens } from "../lib/resolve-account";

export const slackThreadSchema = {
  channel: z.string().describe("Channel ID where the thread lives (e.g., C01ABCDEF)"),
  thread_ts: z.string().describe("Timestamp of the parent message (from slack_read results)"),
  limit: z.number().optional().describe("Max replies to return (default: 50)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleSlackThread(params: {
  channel: string;
  thread_ts: string;
  limit?: number | undefined;
  account?: string | undefined;
}) {
  const resolved = await resolveSlackTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const messages = await readThread(
    resolved.tokens,
    params.channel,
    params.thread_ts,
    params.limit
  );

  if (messages.length === 0) {
    return { content: [{ type: "text" as const, text: "No replies in this thread." }] };
  }

  const lines = messages.map((m) => `[${m.date.slice(0, 16)}] ${m.user}: ${m.text}`);

  return {
    content: [
      {
        type: "text" as const,
        text: `Thread (${messages.length} replies):\n\n${lines.join("\n\n")}`,
      },
    ],
  };
}
