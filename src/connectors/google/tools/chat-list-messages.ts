import { z } from "zod";
import { listMessages } from "../lib/chat";

export const chatListMessagesSchema = {
  space_name: z.string().describe("The resource name of the space (e.g. 'spaces/AAAAMMMMMM')"),
  page_size: z.number().optional().describe("Maximum number of messages to return (default: 20, max: 100)"),
  page_token: z.string().optional().describe("Token for retrieving the next page of results"),
};

export async function handleChatListMessages(params: {
  space_name: string;
  page_size?: number | undefined;
  page_token?: string | undefined;
}) {
  const res = await listMessages(params.space_name, {
    pageSize: params.page_size,
    pageToken: params.page_token,
  });

  if (!res.messages || res.messages.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No messages found in space ${params.space_name}.` }],
    };
  }

  const lines = res.messages.map((m) => {
    const senderName = m.sender.displayName || m.sender.name;
    const date = new Date(m.createTime).toLocaleString();
    return `[${date}] ${senderName}: ${m.text}`;
  });

  let text = `Messages in ${params.space_name}:\n\n${lines.join("\n")}`;
  if (res.nextPageToken) {
    text += `\n\nNext page token: ${res.nextPageToken}`;
  }

  return {
    content: [{ type: "text" as const, text }],
  };
}
