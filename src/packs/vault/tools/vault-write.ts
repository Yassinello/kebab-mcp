import { z } from "zod";
import yaml from "js-yaml";
import { vaultWrite } from "../lib/github";

export const vaultWriteSchema = {
  path: z.string().describe("Path in the vault, e.g. Veille/mon-article.md"),
  content: z.string().describe("Markdown content of the note"),
  message: z.string().optional().describe('Git commit message (default: "Update via MyMCP")'),
  frontmatter: z
    .record(z.string(), z.any())
    .optional()
    .describe("YAML frontmatter object to prepend to the note"),
  sha: z
    .string()
    .optional()
    .describe("Known SHA of existing file (skips extra API call for updates)"),
};

export async function handleVaultWrite(params: {
  path: string;
  content: string;
  message?: string;
  frontmatter?: Record<string, unknown>;
  sha?: string;
}) {
  let content = params.content;

  // Prepend YAML frontmatter if provided (using js-yaml for safe serialization)
  if (params.frontmatter && Object.keys(params.frontmatter).length > 0) {
    const yamlStr = yaml
      .dump(params.frontmatter, {
        lineWidth: -1,
        quotingType: '"',
        forceQuotes: false,
      })
      .trimEnd();
    const frontmatterBlock = `---\n${yamlStr}\n---\n\n`;

    // Replace existing frontmatter or prepend
    if (content.startsWith("---")) {
      const endIndex = content.indexOf("\n---", 3);
      if (endIndex !== -1) {
        content = frontmatterBlock + content.slice(endIndex + 4).trimStart();
      } else {
        content = frontmatterBlock + content;
      }
    } else {
      content = frontmatterBlock + content;
    }
  }

  const result = await vaultWrite(params.path, content, params.message, params.sha);

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
