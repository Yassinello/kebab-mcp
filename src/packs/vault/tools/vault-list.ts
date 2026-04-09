import { z } from "zod";
import { vaultList } from "../lib/github";

export const vaultListSchema = {
  folder: z
    .string()
    .optional()
    .describe("Folder path to list, e.g. Veille/ (default: vault root)"),
};

export async function handleVaultList(params: { folder?: string }) {
  const entries = await vaultList(params.folder);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            folder: params.folder || "/",
            count: entries.length,
            entries: entries.map((e) => ({
              name: e.name,
              path: e.path,
              type: e.type,
              size: e.type === "file" ? e.size : undefined,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}
