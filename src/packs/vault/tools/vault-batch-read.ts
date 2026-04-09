import { z } from "zod";
import yaml from "js-yaml";
import { vaultRead } from "../lib/github";

export const vaultBatchReadSchema = {
  paths: z
    .array(z.string())
    .min(1)
    .max(20)
    .describe("Array of paths to read, e.g. ['Projects/cadens.md', 'Journal/2026-04-01.md']. Max 20."),
};

interface BatchReadResult {
  path: string;
  name: string;
  size: number;
  sha: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
  error?: string;
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  let frontmatter: Record<string, unknown> | null = null;
  let body = content;

  if (content.startsWith("---")) {
    const endIndex = content.indexOf("\n---", 3);
    if (endIndex !== -1) {
      const yamlBlock = content.slice(4, endIndex);
      try {
        const parsed = yaml.load(yamlBlock);
        if (parsed && typeof parsed === "object") {
          frontmatter = parsed as Record<string, unknown>;
        }
      } catch {
        // Invalid YAML — return raw content
      }
      body = content.slice(endIndex + 4).trimStart();
    }
  }

  return { frontmatter, body };
}

export async function handleVaultBatchRead(params: { paths: string[] }) {
  const results = await Promise.allSettled(
    params.paths.map(async (path): Promise<BatchReadResult> => {
      const file = await vaultRead(path);
      const { frontmatter, body } = parseFrontmatter(file.content);
      return {
        path: file.path,
        name: file.name,
        size: file.size,
        sha: file.sha,
        frontmatter,
        body,
      };
    })
  );

  const output = results.map((result, i) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      path: params.paths[i],
      name: params.paths[i].split("/").pop() || params.paths[i],
      size: 0,
      sha: "",
      frontmatter: null,
      body: "",
      error: result.reason?.message || "Failed to read",
    };
  });

  const successCount = output.filter((r) => !r.error).length;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            total: params.paths.length,
            success: successCount,
            failed: params.paths.length - successCount,
            results: output,
          },
          null,
          2
        ),
      },
    ],
  };
}
