import { z } from "zod";
import { createPage } from "../lib/notion-api";
import { resolveNotionTokens } from "../lib/resolve-account";

export const notionCreateSchema = {
  parent_id: z
    .string()
    .optional()
    .describe(
      "Parent ID where the page will be created — may be a PAGE id (creates a sub-page) OR a database id (creates a row). The type is auto-detected. Accepts a bare Notion ID (with or without hyphens)."
    ),
  // Back-compat: older callers pass `database_id`. Still honored; treated as
  // parent_id with auto-detection.
  database_id: z
    .string()
    .optional()
    .describe("Deprecated alias for parent_id (kept for back-compat)."),
  parent_type: z
    .enum(["page", "database"])
    .optional()
    .describe("Optional override to skip parent auto-detection ('page' or 'database')."),
  title: z.string().describe("Page title"),
  content: z
    .string()
    .optional()
    .describe(
      "Page body as Markdown. Supports headings (#/##/###), bulleted/numbered lists, checkboxes ([ ]/[x]), fenced code blocks (```lang), dividers (---), and paragraphs — converted to native Notion blocks."
    ),
  icon: z.string().optional().describe('Page icon: an emoji ("🎯") or an external image URL.'),
  cover: z
    .string()
    .optional()
    .describe("Page cover: an external image URL. Emojis are not valid covers."),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleNotionCreate(params: {
  parent_id?: string | undefined;
  database_id?: string | undefined;
  parent_type?: "page" | "database" | undefined;
  title: string;
  content?: string | undefined;
  icon?: string | undefined;
  cover?: string | undefined;
  account?: string | undefined;
}) {
  const parentId = (params.parent_id ?? params.database_id)?.trim();
  if (!parentId) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Missing parent_id — provide the page or database ID to create the new page under.",
        },
      ],
      isError: true,
    };
  }

  const resolved = await resolveNotionTokens(params.account);
  if (!resolved.ok) return resolved.result;

  // createPage throws on an invalid cover (non-URL) before creating anything.
  let page;
  try {
    page = await createPage(resolved.tokens, {
      parentId,
      title: params.title,
      content: params.content,
      // database_id alias implies a database parent; otherwise honor an explicit
      // parent_type, else auto-detect inside createPage.
      parentType:
        params.parent_type ?? (params.database_id && !params.parent_id ? "database" : undefined),
      icon: params.icon,
      cover: params.cover,
    });
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Page created: ${page.url}`,
      },
    ],
  };
}
