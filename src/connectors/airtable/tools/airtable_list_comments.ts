import { z } from "zod";
import { airtableRequest } from "../lib/airtable-api";

export const airtableListCommentsSchema = {
  base_id: z.string().describe("Airtable base ID"),
  table: z.string().describe("Table name or table ID"),
  record_id: z.string().describe("Record ID (e.g. 'recXXXXXXXXXXXXXX')"),
};

interface Comment {
  id: string;
  author: {
    id: string;
    email: string;
    name: string;
  };
  mentionedUsers?: Record<string, unknown>;
  createdTime: string;
  lastUpdatedTime?: string;
  text: string;
}

interface CommentsResponse {
  comments: Comment[];
  offset?: string;
}

export async function handleAirtableListComments(params: {
  base_id: string;
  table: string;
  record_id: string;
}) {
  const data = await airtableRequest<CommentsResponse>(
    `/${params.base_id}/${encodeURIComponent(params.table)}/${params.record_id}/comments`
  );

  if (!data.comments || data.comments.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No comments found on record \`${params.record_id}\`.`,
        },
      ],
    };
  }

  const commentLines = data.comments.map((comment) => {
    return [
      `### Comment by **${comment.author.name}** (${comment.author.email})`,
      `*Created: ${comment.createdTime}*`,
      "",
      comment.text,
      "",
      "---",
    ].join("\n");
  });

  return {
    content: [
      {
        type: "text" as const,
        text: [`## Comments for Record \`${params.record_id}\``, "", ...commentLines].join("\n"),
      },
    ],
  };
}
