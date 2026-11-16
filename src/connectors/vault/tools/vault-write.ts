import { z } from "zod";
import yaml from "js-yaml";
import { getVaultBackend } from "../lib/select";
import { ensureProvenance, noteProvenance, parseNoteFrontmatter } from "../lib/provenance";
import { withMarkdownExtension } from "../lib/paths";

export const vaultWriteSchema = {
  path: z
    .string()
    .describe(
      "Path in the vault, e.g. Veille/mon-article.md ('.md' is added when there is no extension)"
    ),
  content: z.string().describe("Markdown content of the note"),
  message: z
    .string()
    .optional()
    .describe('Change message: the Git commit message on GitHub (default: "Update via Kebab MCP")'),
  frontmatter: z
    .record(z.string(), z.any())
    .optional()
    .describe("YAML frontmatter object to prepend to the note"),
  sha: z
    .string()
    .optional()
    .describe(
      "Version (sha) of the note from a previous vault_read. The write is refused if the note changed since."
    ),
};

export async function handleVaultWrite(params: {
  path: string;
  content: string;
  message?: string | undefined;
  frontmatter?: Record<string, unknown> | undefined;
  sha?: string | undefined;
}) {
  let content = params.content;

  // Prepend YAML frontmatter if provided (using js-yaml for safe serialization)
  if (params.frontmatter && Object.keys(params.frontmatter).length > 0) {
    const frontmatter = { ...params.frontmatter };
    // TRU-03: the frontmatter object replaces any block already in `content`;
    // carry an existing provenance over instead of silently dropping it.
    if (!Object.prototype.hasOwnProperty.call(frontmatter, "provenance")) {
      const existing = parseNoteFrontmatter(content)?.provenance;
      if (existing !== undefined) frontmatter.provenance = existing;
    }
    const yamlStr = yaml
      .dump(frontmatter, {
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

  // TRU-03: model-written notes are tagged `provenance: assistant` unless the
  // frontmatter already declares a provenance (never clobbered).
  content = ensureProvenance(content, "assistant");

  // B1: a note saved without extension is invisible to lists, stats and the
  // export — save `Inbox/2026-11-15` as `Inbox/2026-11-15.md`.
  const target = withMarkdownExtension(params.path);
  const result = await getVaultBackend().write(target.path, content, {
    message: params.message,
    expectedVersion: params.sha,
  });

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
            provenance: noteProvenance(content),
            ...(target.added
              ? { note: `Saved as ${target.path}: notes need the .md extension.` }
              : {}),
            // KV backend only: soft-limit warning (vault above 50 MB).
            ...(result.warning ? { warning: result.warning } : {}),
          },
          null,
          2
        ),
      },
    ],
  };
}
