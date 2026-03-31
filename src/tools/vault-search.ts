import { z } from "zod";
import { vaultSearch } from "@/lib/github";

export const vaultSearchSchema = {
  query: z.string().describe("Search terms"),
  folder: z
    .string()
    .optional()
    .describe("Filter by folder, e.g. Veille/"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe("Max results (default: 10)"),
};

export async function handleVaultSearch(params: {
  query: string;
  folder?: string;
  limit?: number;
}) {
  const results = await vaultSearch(
    params.query,
    params.folder,
    params.limit || 10
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            count: results.length,
            results: results.map((r) => ({
              name: r.name,
              path: r.path,
              matches: r.textMatches,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}
