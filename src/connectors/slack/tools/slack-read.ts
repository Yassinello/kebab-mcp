import { z } from "zod";
import { readMessages } from "../lib/slack-api";
import { resolveSlackTokens } from "../lib/resolve-account";

export const slackReadSchema = {
  channel: z.string().describe("Channel ID (e.g., C01ABCDEF). Use slack_channels to find IDs."),
  limit: z.number().optional().describe("Max messages to return (default: 20)"),
  oldest: z
    .string()
    .optional()
    .describe(
      "Only messages at/after this time. Accepts an ISO timestamp (2026-06-18T00:00:00Z) or a Unix-seconds string. Use for 'last 24h'-style reads."
    ),
  latest: z
    .string()
    .optional()
    .describe("Only messages at/before this time. ISO timestamp or Unix-seconds string."),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

/**
 * Slack history bounds are Unix seconds with a fractional part ("ts" format).
 * Accept an ISO string or a numeric string and normalize to seconds. Returns
 * undefined for blank/invalid input so the bound is simply dropped.
 */
export function toSlackTs(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Already a Unix-seconds value (optionally fractional).
  if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return undefined;
  return String(ms / 1000);
}

export async function handleSlackRead(params: {
  channel: string;
  limit?: number | undefined;
  oldest?: string | undefined;
  latest?: string | undefined;
  account?: string | undefined;
}) {
  const resolved = await resolveSlackTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const messages = await readMessages(resolved.tokens, params.channel, params.limit, {
    oldest: toSlackTs(params.oldest),
    latest: toSlackTs(params.latest),
  });

  if (messages.length === 0) {
    return { content: [{ type: "text" as const, text: "No messages found." }] };
  }

  const lines = messages.map((m) => {
    const thread = m.replyCount ? ` [${m.replyCount} replies]` : "";
    return `[${m.date.slice(0, 16)}] ${m.user}: ${m.text}${thread}`;
  });

  return {
    content: [{ type: "text" as const, text: lines.join("\n\n") }],
  };
}
