import { z } from "zod";
import { getDatabaseSchema } from "../lib/notion-api";
import { resolveNotionTokens } from "../lib/resolve-account";

export const notionDbSchemaSchema = {
  database_id: z.string().describe("Notion database ID to introspect"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleNotionDbSchema(params: {
  database_id: string;
  account?: string | undefined;
}) {
  const resolved = await resolveNotionTokens(params.account);
  if (!resolved.ok) return resolved.result;

  const schema = await getDatabaseSchema(resolved.tokens, params.database_id);

  const lines = schema.properties.map((p) => {
    const opts = p.options?.length ? ` — options: ${p.options.join(", ")}` : "";
    return `- ${p.name} (${p.type})${opts}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Database: ${schema.title}\nProperties:\n${lines.join("\n")}`,
      },
    ],
  };
}
