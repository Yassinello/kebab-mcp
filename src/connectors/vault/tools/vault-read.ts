import { z } from "zod";
import { loadVaultYaml } from "../lib/yaml-safe";
import { getVaultBackend } from "../lib/select";
import { readFirstExisting } from "../lib/backend";
import { withMarkdownExtension } from "../lib/paths";

export const vaultReadSchema = {
  path: z.string().describe("Path in the vault, e.g. Projects/cadens.md"),
};

export async function handleVaultRead(params: { path: string }) {
  // A path without extension also finds the note saved as `<path>.md`.
  const md = withMarkdownExtension(params.path);
  const file = await readFirstExisting(
    getVaultBackend(),
    md.added ? [params.path, md.path] : [params.path]
  );

  // Parse frontmatter with js-yaml
  let frontmatter: Record<string, unknown> | null = null;
  let body = file.content;

  if (file.content.startsWith("---")) {
    const endIndex = file.content.indexOf("\n---", 3);
    if (endIndex !== -1) {
      const yamlBlock = file.content.slice(4, endIndex);
      try {
        const parsed = loadVaultYaml(yamlBlock);
        if (parsed && typeof parsed === "object") {
          frontmatter = parsed as Record<string, unknown>;
        }
      } catch {
        // Invalid YAML — return raw content without parsed frontmatter
      }
      body = file.content.slice(endIndex + 4).trimStart();
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { path: file.path, name: file.name, size: file.size, sha: file.sha, frontmatter, body },
          null,
          2
        ),
      },
    ],
  };
}
