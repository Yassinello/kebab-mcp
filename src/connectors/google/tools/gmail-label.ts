import { z } from "zod";
import { modifyLabels } from "../lib/gmail";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const gmailLabelSchema = {
  message_id: z.string().describe("Gmail message ID"),
  add: z
    .string()
    .optional()
    .describe(
      "Comma-separated label IDs to add. Common: STARRED, IMPORTANT, UNREAD, INBOX, TRASH, SPAM"
    ),
  remove: z
    .string()
    .optional()
    .describe(
      'Comma-separated label IDs to remove. Use "UNREAD" to mark as read, "INBOX" to archive'
    ),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleGmailLabel(params: {
  message_id: string;
  add?: string | undefined;
  remove?: string | undefined;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const addLabels = params.add ? params.add.split(",").map((l) => l.trim()) : [];
  const removeLabels = params.remove ? params.remove.split(",").map((l) => l.trim()) : [];

  const ok = await modifyLabels(r.ctx, params.message_id, addLabels, removeLabels);

  const actions: string[] = [];
  if (addLabels.length) actions.push(`added: ${addLabels.join(", ")}`);
  if (removeLabels.length) actions.push(`removed: ${removeLabels.join(", ")}`);

  return {
    content: [
      {
        type: "text" as const,
        text: ok
          ? `Labels updated — ${actions.join("; ")}`
          : `Failed to update labels for ${params.message_id}`,
      },
    ],
  };
}
