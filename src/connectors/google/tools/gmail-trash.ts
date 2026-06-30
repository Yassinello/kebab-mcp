import { z } from "zod";
import { trashEmail } from "../lib/gmail";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const gmailTrashSchema = {
  message_id: z
    .string()
    .describe("Gmail message ID to trash. Get it from gmail_inbox results or gmail_search."),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleGmailTrash(params: {
  message_id: string;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const ok = await trashEmail(r.ctx, params.message_id);
  return {
    content: [
      {
        type: "text" as const,
        text: ok
          ? `Message ${params.message_id} moved to trash.`
          : `Failed to trash message ${params.message_id}.`,
      },
    ],
  };
}
