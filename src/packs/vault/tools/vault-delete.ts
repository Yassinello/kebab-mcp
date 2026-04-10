import { z } from "zod";
import { vaultDelete } from "../lib/github";

export const vaultDeleteSchema = {
  path: z.string().describe("Path of the note to delete, e.g. Veille/old-article.md"),
  message: z.string().optional().describe("Git commit message for the deletion"),
};

export async function handleVaultDelete(params: { path: string; message?: string }) {
  const result = await vaultDelete(params.path, params.message);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            action: "deleted",
            path: result.path,
          },
          null,
          2
        ),
      },
    ],
  };
}
