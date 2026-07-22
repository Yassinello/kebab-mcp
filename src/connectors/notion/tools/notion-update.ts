import { z } from "zod";
import { updatePage, MAX_REPLACE_BLOCKS } from "../lib/notion-api";
import { MARKDOWN_SYNTAX_HELP } from "../lib/markdown-syntax";
import { resolveNotionTokens } from "../lib/resolve-account";
import { toMsg } from "@/core/error-utils";

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
      `ADD to the end of the page, keeping existing content. ${MARKDOWN_SYNTAX_HELP} Mutually exclusive with replace_content.`
    ),
  replace_content: z
    .string()
    .optional()
    .describe(
      `REPLACE the entire page body: every existing block is deleted, then this content is written — use it to iterate on a generated document instead of appending to it. Deleted blocks go to the Notion trash and stay recoverable. Capped at ${MAX_REPLACE_BLOCKS} existing top-level blocks (Notion deletes one per request); above that the call is refused without changing anything. Same syntax as append_content. Mutually exclusive with append_content.`
    ),
  after_block_id: z
    .string()
    .optional()
    .describe(
      "Insert append_content directly AFTER this block (must be a direct child of the page) instead of at the end. Notion has no 'prepend' — anchoring is always after an existing block. Ignored when replace_content is used."
    ),
  icon: z
    .string()
    .optional()
    .describe(
      'Page icon: an emoji ("🎯") or an external image URL. Pass "none" to remove the current icon.'
    ),
  cover: z
    .string()
    .optional()
    .describe(
      'Page cover: an external image URL. Pass "none" to remove the current cover. Emojis are not valid covers.'
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
  replace_content?: string | undefined;
  after_block_id?: string | undefined;
  icon?: string | undefined;
  cover?: string | undefined;
  archive?: boolean | undefined;
  account?: string | undefined;
}) {
  const resolved = await resolveNotionTokens(params.account);
  if (!resolved.ok) return resolved.result;

  // The api layer throws on conflicting/invalid input (append+replace, a
  // non-URL cover) and on a partial replace_content. Surface those as an
  // isError envelope — the message carries the recovery path — instead of
  // letting them bubble up as an unhandled tool crash.
  let result;
  try {
    result = await updatePage(resolved.tokens, params.page_id, {
      properties: params.properties,
      appendContent: params.append_content,
      replaceContent: params.replace_content,
      afterBlockId: params.after_block_id,
      icon: params.icon,
      cover: params.cover,
      archive: params.archive,
    });
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: toMsg(err) }],
      isError: true,
    };
  }

  if (params.archive) {
    return {
      content: [{ type: "text" as const, text: `Page archived: ${result.url}` }],
    };
  }

  const actions: string[] = [];
  if (params.properties)
    actions.push(`${Object.keys(params.properties).length} properties updated`);
  if (params.replace_content !== undefined)
    // "top-level": deleting a parent trashes its subtree, so the count is of
    // blocks we issued a DELETE for, not of every block that went away.
    actions.push(`content replaced (${result.deletedBlocks ?? 0} top-level blocks removed)`);
  if (params.append_content) actions.push("content appended");
  if (params.icon !== undefined) actions.push("icon set");
  if (params.cover !== undefined) actions.push("cover set");

  return {
    content: [
      {
        type: "text" as const,
        text: `Page updated: ${result.url}\n${actions.join(", ")}`,
      },
    ],
  };
}
