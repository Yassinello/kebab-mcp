import { z } from "zod";
import { readPage } from "../lib/notion-api";
import { resolveNotionTokens } from "../lib/resolve-account";

export const notionReadSchema = {
  page_id: z.string().describe("Notion page ID (from notion_search results or page URL)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleNotionRead(params: { page_id: string; account?: string | undefined }) {
  const resolved = await resolveNotionTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const page = await readPage(resolved.tokens, params.page_id);

  // Surface truncation as a leading warning, not just as the inline marker at
  // the bottom — an agent that acts on a partial read (e.g. rewriting the page
  // with replace_content) would otherwise drop everything it never saw.
  const warning = page.truncated
    ? "> WARNING: this page was only partially read (read bound reached). Do NOT rewrite it with replace_content — the unread content would be lost.\n\n"
    : "";

  return {
    content: [
      {
        type: "text" as const,
        text: `# ${page.title}\n\n${warning}${page.content || "(empty page)"}`,
      },
    ],
  };
}
