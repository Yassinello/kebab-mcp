import { z } from "zod";
import { airtableRequest } from "../lib/airtable-api";

export const airtableCreateCommentSchema = {
  base_id: z.string().describe("Airtable base ID"),
  table: z.string().describe("Table name or table ID"),
  record_id: z.string().describe("Record ID (e.g. 'recXXXXXXXXXXXXXX')"),
  text: z
    .string()
    .describe(
      "The text content of the comment. Mentions can be formatted as @[user name or email]."
    ),
};

interface CommentResponse {
  id: string;
  author: {
    id: string;
    email: string;
    name: string;
  };
  createdTime: string;
  text: string;
}

export async function handleAirtableCreateComment(params: {
  base_id: string;
  table: string;
  record_id: string;
  text: string;
}) {
  const data = await airtableRequest<CommentResponse>(
    `/${params.base_id}/${encodeURIComponent(params.table)}/${params.record_id}/comments`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: params.text }),
    }
  );

  return {
    content: [
      {
        type: "text" as const,
        text: [
          `✅ Comment successfully created on record \`${params.record_id}\`.`,
          `**Comment ID:** \`${data.id}\``,
          `**Author:** ${data.author.name} (${data.author.email})`,
          `**Created Time:** ${data.createdTime}`,
          "",
          `**Content:**`,
          data.text,
        ].join("\n"),
      },
    ],
  };
}
