import { z } from "zod";
import { vaultRead, vaultTree } from "../lib/github";

export const vaultBacklinksSchema = {
  path: z
    .string()
    .describe("Path of the note to find backlinks for, e.g. 'Projects/cadens.md'"),
};

export async function handleVaultBacklinks(params: { path: string }) {
  // Extract the note name (without extension) for wikilink matching
  const fileName = params.path.split("/").pop() || params.path;
  const noteName = fileName.replace(/\.md$/, "");

  // Patterns to search for:
  // - [[noteName]] (standard wikilink)
  // - [[noteName|alias]] (aliased wikilink)
  // - [[path/to/noteName]] (full path wikilink)
  const wikiLinkPatterns = [
    `[[${noteName}]]`,
    `[[${noteName}|`,
    `[[${params.path.replace(/\.md$/, "")}]]`,
    `[[${params.path.replace(/\.md$/, "")}|`,
  ];

  // Get all markdown files in the vault
  const tree = await vaultTree();
  const mdFiles = tree.filter(
    (f) => f.path.endsWith(".md") && f.path !== params.path
  );

  // Read files in parallel (batch of 10 to avoid rate limiting)
  const BATCH_SIZE = 10;
  const backlinks: Array<{
    path: string;
    context: string;
  }> = [];

  for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
    const batch = mdFiles.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const content = await vaultRead(file.path);
        return { path: file.path, content: content.content };
      })
    );

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { path, content } = result.value;

      // Check if any wikilink pattern exists in the content
      const hasLink = wikiLinkPatterns.some((pattern) =>
        content.includes(pattern)
      );
      if (!hasLink) continue;

      // Extract context around the first match
      const lowerContent = content.toLowerCase();
      const lowerName = noteName.toLowerCase();
      const idx = lowerContent.indexOf(`[[${lowerName}`);
      if (idx === -1) continue;

      const start = Math.max(0, idx - 60);
      const end = Math.min(content.length, idx + noteName.length + 80);
      const context =
        (start > 0 ? "..." : "") +
        content.slice(start, end).trim() +
        (end < content.length ? "..." : "");

      backlinks.push({ path, context });
    }
  }

  // Also extract forward links from the target note itself
  const targetFile = await vaultRead(params.path);
  const forwardLinks: string[] = [];
  const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = linkRegex.exec(targetFile.content)) !== null) {
    const linked = match[1].trim();
    if (!forwardLinks.includes(linked)) {
      forwardLinks.push(linked);
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            note: params.path,
            backlinks: {
              count: backlinks.length,
              notes: backlinks,
            },
            forwardLinks: {
              count: forwardLinks.length,
              links: forwardLinks,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}
