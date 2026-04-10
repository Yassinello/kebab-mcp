import { z } from "zod";
import { vaultSearch } from "../lib/github";

export const vaultSearchSchema = {
  query: z.string().describe("Search terms"),
  folder: z.string().optional().describe("Filter by folder, e.g. Veille/"),
  limit: z.number().int().min(1).max(100).optional().describe("Max results per page (default: 10)"),
  page: z.number().int().min(1).optional().describe("Page number for pagination (default: 1)"),
};

export async function handleVaultSearch(params: {
  query: string;
  folder?: string;
  limit?: number;
  page?: number;
}) {
  const { results, totalCount, method } = await vaultSearch(
    params.query,
    params.folder,
    params.limit || 10,
    params.page || 1
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            totalCount,
            page: params.page || 1,
            count: results.length,
            method,
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
