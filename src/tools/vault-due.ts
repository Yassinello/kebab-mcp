import { z } from "zod";
import yaml from "js-yaml";
import { vaultRead, vaultTree } from "@/lib/github";

export const vaultDueSchema = {
  before: z
    .string()
    .optional()
    .describe("ISO date string — return notes with resurface date on or before this date (default: today)"),
  folder: z
    .string()
    .optional()
    .describe("Restrict to a specific folder"),
};

interface DueNote {
  path: string;
  title: string;
  resurface: string;
  snippet: string;
}

export async function handleVaultDue(params: {
  before?: string;
  folder?: string;
}) {
  const cutoff = params.before || new Date().toISOString().split("T")[0];

  // Get all markdown files
  const tree = await vaultTree(params.folder);
  const mdFiles = tree.filter((f) => f.path.endsWith(".md"));

  // Read files in batches to find those with resurface frontmatter
  const BATCH_SIZE = 10;
  const dueNotes: DueNote[] = [];

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

      // Parse frontmatter
      if (!content.startsWith("---")) continue;
      const endIndex = content.indexOf("\n---", 3);
      if (endIndex === -1) continue;

      const yamlBlock = content.slice(4, endIndex);
      let frontmatter: Record<string, unknown>;
      try {
        const parsed = yaml.load(yamlBlock);
        if (!parsed || typeof parsed !== "object") continue;
        frontmatter = parsed as Record<string, unknown>;
      } catch {
        continue;
      }

      // Check resurface field
      const resurface = frontmatter.resurface;
      if (!resurface) continue;

      let resurfaceDate: string;
      if (resurface instanceof Date) {
        resurfaceDate = resurface.toISOString().split("T")[0];
      } else if (typeof resurface === "string") {
        // Handle "when_relevant" — always include these
        if (resurface === "when_relevant") {
          resurfaceDate = "when_relevant";
        } else {
          resurfaceDate = resurface.split("T")[0];
        }
      } else {
        continue;
      }

      // Include if date is on or before cutoff, or if "when_relevant"
      if (resurfaceDate !== "when_relevant" && resurfaceDate > cutoff) continue;

      // Extract snippet (first 150 chars of body)
      const body = content.slice(endIndex + 4).trim();
      const snippet = body.slice(0, 150).trim() + (body.length > 150 ? "..." : "");

      dueNotes.push({
        path,
        title: (frontmatter.title as string) || path.split("/").pop()?.replace(/\.md$/, "") || path,
        resurface: resurfaceDate,
        snippet,
      });
    }
  }

  // Sort: dated notes first (oldest first), then "when_relevant"
  dueNotes.sort((a, b) => {
    if (a.resurface === "when_relevant" && b.resurface !== "when_relevant") return 1;
    if (a.resurface !== "when_relevant" && b.resurface === "when_relevant") return -1;
    return a.resurface.localeCompare(b.resurface);
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            cutoffDate: cutoff,
            count: dueNotes.length,
            notes: dueNotes,
          },
          null,
          2
        ),
      },
    ],
  };
}
