import { z } from "zod";
import { vaultRecentCommits } from "@/lib/github";

export const vaultRecentSchema = {
  n: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Number of recently modified notes to return (default: 10, max: 50)"),
  folder: z
    .string()
    .optional()
    .describe("Restrict to a specific folder, e.g. 'Journal/' or 'Projects/'"),
  since: z
    .string()
    .optional()
    .describe("ISO date string to filter notes modified after this date, e.g. '2026-03-25' or '2026-03-25T00:00:00Z'"),
};

export async function handleVaultRecent(params: {
  n?: number;
  folder?: string;
  since?: string;
}) {
  const limit = params.n ?? 10;
  const results = await vaultRecentCommits(limit, params.folder, params.since);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            count: results.length,
            ...(params.since ? { since: params.since } : {}),
            notes: results,
          },
          null,
          2
        ),
      },
    ],
  };
}
