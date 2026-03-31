import { z } from "zod";
import { vaultRead } from "@/lib/github";

export const vaultReadSchema = {
  path: z.string().describe("Path in the vault, e.g. Projects/cadens.md"),
};

export async function handleVaultRead(params: { path: string }) {
  const file = await vaultRead(params.path);

  // Parse frontmatter if present
  let frontmatter: Record<string, string> | null = null;
  let body = file.content;

  if (file.content.startsWith("---")) {
    const endIndex = file.content.indexOf("---", 3);
    if (endIndex !== -1) {
      const yamlBlock = file.content.slice(3, endIndex).trim();
      frontmatter = {};
      for (const line of yamlBlock.split("\n")) {
        const colonIndex = line.indexOf(":");
        if (colonIndex > 0) {
          const key = line.slice(0, colonIndex).trim();
          const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, "");
          frontmatter[key] = value;
        }
      }
      body = file.content.slice(endIndex + 3).trimStart();
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            path: file.path,
            name: file.name,
            size: file.size,
            frontmatter,
            body,
          },
          null,
          2
        ),
      },
    ],
  };
}
