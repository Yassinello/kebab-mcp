import { z } from "zod";
import { createPage } from "../lib/notion-api";
import { resolveNotionTokens } from "../lib/resolve-account";

export const notionCreateSchema = {
  database_id: z.string().describe("Parent database ID where the page will be created"),
  title: z.string().describe("Page title"),
  content: z
    .string()
    .optional()
    .describe("Page content as plain text (paragraphs separated by double newlines)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleNotionCreate(params: {
  database_id: string;
  title: string;
  content?: string | undefined;
  account?: string | undefined;
}) {
  const resolved = await resolveNotionTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const page = await createPage(resolved.tokens, {
    parentId: params.database_id,
    title: params.title,
    content: params.content,
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Page created: ${page.url}`,
      },
    ],
  };
}
