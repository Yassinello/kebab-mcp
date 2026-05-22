import { z } from "zod";
import { getUserProfile } from "../lib/slack-api";
import { resolveSlackTokens } from "../lib/resolve-account";

export const slackProfileSchema = {
  user: z.string().describe("User ID (e.g., U01ABCDEF). Found in slack_read message results."),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleSlackProfile(params: { user: string; account?: string | undefined }) {
  const resolved = await resolveSlackTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const profile = await getUserProfile(resolved.tokens, params.user);

  const lines = [
    `**${profile.realName}** (@${profile.displayName})`,
    profile.title ? `Title: ${profile.title}` : null,
    profile.email ? `Email: ${profile.email}` : null,
    profile.phone ? `Phone: ${profile.phone}` : null,
    `Timezone: ${profile.tz}`,
    `Status: ${profile.statusEmoji ? `${profile.statusEmoji} ` : ""}${profile.statusText || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    content: [{ type: "text" as const, text: lines }],
  };
}
