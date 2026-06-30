import { z } from "zod";
import { createMessage } from "../lib/chat";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const chatSendMessageSchema = {
  space_name: z.string().describe("The resource name of the space (e.g. 'spaces/AAAAMMMMMM')"),
  text: z.string().describe("The text message to send"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleChatSendMessage(params: {
  space_name: string;
  text: string;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const message = await createMessage(r.ctx, params.space_name, params.text);
  const senderName = message.sender.displayName || message.sender.name || "(unknown)";
  const date = message.createTime || "(no date)";

  return {
    content: [
      {
        type: "text" as const,
        text: `Message successfully sent to ${params.space_name}!\n\n[${date}] ${senderName}: ${message.text}`,
      },
    ],
  };
}
