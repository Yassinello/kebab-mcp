import { z } from "zod";
import { modifyLabels } from "../lib/gmail";

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
};

export async function handleGmailLabel(params: {
  message_id: string;
  add?: string;
  remove?: string;
}) {
  const addLabels = params.add ? params.add.split(",").map((l) => l.trim()) : [];
  const removeLabels = params.remove ? params.remove.split(",").map((l) => l.trim()) : [];

  const ok = await modifyLabels(params.message_id, addLabels, removeLabels);

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
