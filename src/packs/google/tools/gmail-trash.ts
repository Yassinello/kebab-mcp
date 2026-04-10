import { z } from "zod";
import { trashEmail } from "../lib/gmail";

export const gmailTrashSchema = {
  message_id: z
    .string()
    .describe("Gmail message ID to trash. Get it from gmail_inbox results or gmail_search."),
};

export async function handleGmailTrash(params: { message_id: string }) {
  const ok = await trashEmail(params.message_id);
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
