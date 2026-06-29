import { z } from "zod";
import { createMessage } from "../lib/chat";

export const chatSendMessageSchema = {
  space_name: z.string().describe("The resource name of the space (e.g. 'spaces/AAAAMMMMMM')"),
  text: z.string().describe("The text message to send"),
};

export async function handleChatSendMessage(params: {
  space_name: string;
  text: string;
}) {
  const message = await createMessage(params.space_name, params.text);
  const senderName = message.sender.displayName || message.sender.name;
  const date = new Date(message.createTime).toLocaleString();

  return {
    content: [
      {
        type: "text" as const,
        text: `Message successfully sent to ${params.space_name}!\n\n[${date}] ${senderName}: ${message.text}`,
      },
    ],
  };
}
