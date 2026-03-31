import { z } from "zod";
import { vaultWrite } from "@/lib/github";

export const vaultWriteSchema = {
  path: z.string().describe("Path in the vault, e.g. Veille/mon-article.md"),
  content: z.string().describe("Markdown content of the note"),
  message: z
    .string()
    .optional()
    .describe('Git commit message (default: "Update via YassMCP")'),
  frontmatter: z
    .record(z.string(), z.any())
    .optional()
    .describe("YAML frontmatter object to prepend to the note"),
};

export async function handleVaultWrite(params: {
  path: string;
  content: string;
  message?: string;
  frontmatter?: Record<string, any>;
}) {
  let content = params.content;

  // Prepend YAML frontmatter if provided
  if (params.frontmatter && Object.keys(params.frontmatter).length > 0) {
    const yamlLines = Object.entries(params.frontmatter).map(
      ([key, value]) => {
        if (Array.isArray(value)) {
          return `${key}:\n${value.map((v) => `  - ${v}`).join("\n")}`;
        }
        return `${key}: ${typeof value === "string" ? `"${value}"` : value}`;
      }
    );
    const frontmatterBlock = `---\n${yamlLines.join("\n")}\n---\n\n`;

    // Replace existing frontmatter or prepend
    if (content.startsWith("---")) {
      const endIndex = content.indexOf("---", 3);
      if (endIndex !== -1) {
        content = frontmatterBlock + content.slice(endIndex + 3).trimStart();
      } else {
        content = frontmatterBlock + content;
      }
    } else {
      content = frontmatterBlock + content;
    }
  }

  const result = await vaultWrite(params.path, content, params.message);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            action: result.created ? "created" : "updated",
            path: result.path,
            sha: result.sha,
          },
          null,
          2
        ),
      },
    ],
  };
}
