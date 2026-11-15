import { z } from "zod";
import { getVaultBackend } from "../lib/select";

export const vaultStatsSchema = {
  folder: z
    .string()
    .optional()
    .describe("Restrict stats to a specific folder (default: entire vault)"),
};

export async function handleVaultStats(params: { folder?: string | undefined }) {
  // Notes per folder and total size (`.md` only) — see computeStats().
  const { totalNotes, totalSize, folderCounts, warning } = await getVaultBackend().stats(
    params.folder
  );

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
            // KV backend only: soft-limit warning (vault above 50 MB).
            ...(warning ? { warning } : {}),
          },
          null,
          2
        ),
      },
    ],
  };
}
