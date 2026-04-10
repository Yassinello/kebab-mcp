import { z } from "zod";
import { vaultTree } from "../lib/github";

export const vaultStatsSchema = {
  folder: z
    .string()
    .optional()
    .describe("Restrict stats to a specific folder (default: entire vault)"),
};

export async function handleVaultStats(params: { folder?: string }) {
  const tree = await vaultTree(params.folder);

  // Count notes per folder
  const folderCounts: Record<string, number> = {};
  let totalNotes = 0;
  let totalSize = 0;

  for (const file of tree) {
    if (!file.path.endsWith(".md")) continue;
    totalNotes++;
    totalSize += file.size || 0;

    const folder = file.path.includes("/") ? file.path.split("/").slice(0, -1).join("/") : "(root)";
    folderCounts[folder] = (folderCounts[folder] || 0) + 1;
  }

  // Sort folders by count descending
  const byFolder = Object.entries(folderCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([folder, count]) => ({ folder, count }));

  // Inbox count (common triage folder)
  const inboxCount = folderCounts["Inbox"] || folderCounts["inbox"] || 0;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            totalNotes,
            totalSizeKB: Math.round(totalSize / 1024),
            inboxCount,
            folderCount: Object.keys(folderCounts).length,
            byFolder,
          },
          null,
          2
        ),
      },
    ],
  };
}
