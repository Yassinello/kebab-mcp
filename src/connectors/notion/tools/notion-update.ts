import { z } from "zod";
import { updatePage } from "../lib/notion-api";
import { resolveNotionTokens } from "../lib/resolve-account";

export const notionUpdateSchema = {
  page_id: z.string().describe("Notion page ID to update"),
  properties: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Properties to update as key-value pairs. Each value is typed automatically from the parent database schema, so select/status/date/multi_select/people work — e.g. {"Status": "Done", "Due": "2026-07-01", "Tags": "urgent, q3"}. Use the key "title" to rename the page. For multi_select/people, pass a comma-separated string. Call notion_get_db_schema first to see valid property names + select options.'
    ),
  append_content: z
    .string()
    .optional()
    .describe(
      "Markdown to append to the page — supports headings (#/##/###), bulleted/numbered lists, checkboxes ([ ]/[x]), fenced code blocks, dividers (---), and paragraphs. Converted to native Notion blocks."
    ),
  archive: z
    .boolean()
    .optional()
    .describe("Set true to archive (move to trash) the page. Ignores other fields when set."),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleNotionUpdate(params: {
  page_id: string;
  properties?: Record<string, string | number | boolean> | undefined;
  append_content?: string | undefined;
  archive?: boolean | undefined;
  account?: string | undefined;
}) {
  const resolved = await resolveNotionTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const result = await updatePage(
    resolved.tokens,
    params.page_id,
    params.properties,
    params.append_content,
    params.archive
  );

  if (params.archive) {
    return {
      content: [{ type: "text" as const, text: `Page archived: ${result.url}` }],
    };
  }

  const actions: string[] = [];
  if (params.properties)
    actions.push(`${Object.keys(params.properties).length} properties updated`);
  if (params.append_content) actions.push("content appended");

  return {
    content: [
      {
        type: "text" as const,
        text: `Page updated: ${result.url}\n${actions.join(", ")}`,
      },
    ],
  };
}
