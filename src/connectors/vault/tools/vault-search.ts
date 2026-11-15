import { z } from "zod";
import type { SearchResult, VaultBackend } from "../lib/backend";
import { getVaultBackend } from "../lib/select";
import { noteProvenance, type Provenance } from "../lib/provenance";

export const vaultSearchSchema = {
  query: z.string().describe("Search terms"),
  folder: z.string().optional().describe("Filter by folder, e.g. Veille/"),
  limit: z.number().int().min(1).max(100).optional().describe("Max results per page (default: 10)"),
  page: z.number().int().min(1).optional().describe("Page number for pagination (default: 1)"),
};

/**
 * TRU-03: at most this many extra note reads per search to resolve the
 * provenance of results whose content the search did not already fetch
 * (GitHub code search and filename matches return no content). Results
 * beyond the cap report `provenance: "unknown"`; vault_read gives the
 * frontmatter.
 */
const PROVENANCE_LOOKUP_CAP = 20;

async function resolveProvenance(
  vault: VaultBackend,
  results: SearchResult[]
): Promise<Array<Provenance | "unknown">> {
  let budget = PROVENANCE_LOOKUP_CAP;
  return Promise.all(
    results.map(async (r): Promise<Provenance | "unknown"> => {
      if (r.provenance) return r.provenance;
      if (budget <= 0) return "unknown";
      budget--;
      try {
        const file = await vault.read(r.path);
        return noteProvenance(file.content);
      } catch {
        return "unknown";
      }
    })
  );
}

export async function handleVaultSearch(params: {
  query: string;
  folder?: string | undefined;
  limit?: number | undefined;
  page?: number | undefined;
}) {
  const vault = getVaultBackend();
  const { results, totalCount, method, truncated } = await vault.search(params.query, {
    folder: params.folder,
    limit: params.limit || 10,
    page: params.page || 1,
  });
  const provenance = await resolveProvenance(vault, results);

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
            // KV backend only: the content scan hit its cap.
            ...(truncated ? { truncated } : {}),
            results: results.map((r, i) => ({
              name: r.name,
              path: r.path,
              provenance: provenance[i],
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
