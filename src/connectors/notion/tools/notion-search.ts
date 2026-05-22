import { z } from "zod";
import { searchNotion } from "../lib/notion-api";
import { resolveNotionTokens } from "../lib/resolve-account";

export const notionSearchSchema = {
  query: z.string().describe("Search query — matches page titles and content"),
  limit: z.number().optional().describe("Max results (default: 10)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleNotionSearch(params: {
  query: string;
  limit?: number | undefined;
  account?: string | undefined;
}) {
  const resolved = await resolveNotionTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const pages = await searchNotion(resolved.tokens, params.query, params.limit);

  if (pages.length === 0) {
    return { content: [{ type: "text" as const, text: "No pages found." }] };
  }

  const lines = pages.map((p) => {
    const props = Object.entries(p.properties)
      .filter(([k]) => k !== "title" && k !== "Name")
      .map(([k, v]) => `${k}: ${v}`)
      .join(" | ");
    return `**${p.title}**\n${p.url}\nEdited: ${p.lastEdited.slice(0, 10)}${props ? `\n${props}` : ""}`;
  });

  return {
    content: [{ type: "text" as const, text: lines.join("\n\n---\n\n") }],
  };
}
