import { z } from "zod";
import { listSpaces } from "../lib/chat";

export const chatListSpacesSchema = {
  page_size: z
    .number()
    .optional()
    .describe("Maximum number of spaces to return (default: 20, max: 100)"),
  page_token: z.string().optional().describe("Token for retrieving the next page of results"),
};

export async function handleChatListSpaces(params: {
  page_size?: number | undefined;
  page_token?: string | undefined;
}) {
  const res = await listSpaces({
    pageSize: params.page_size,
    pageToken: params.page_token,
  });

  if (!res.spaces || res.spaces.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No Google Chat spaces found." }],
    };
  }

  const lines = res.spaces.map((s) => {
    const typeLabel = s.type === "DM" ? "Direct Message" : "Space";
    const displayName = s.displayName ? ` — ${s.displayName}` : "";
    return `- [${s.name}] (${typeLabel})${displayName}`;
  });

  let text = `Google Chat Spaces:\n\n${lines.join("\n")}`;
  if (res.nextPageToken) {
    text += `\n\nNext page token: ${res.nextPageToken}`;
  }

  return {
    content: [{ type: "text" as const, text }],
  };
}
