import { z } from "zod";
import { getVaultBackend } from "../lib/select";

export const vaultDeleteSchema = {
  path: z.string().describe("Path of the note to delete, e.g. Veille/old-article.md"),
  message: z
    .string()
    .optional()
    .describe("Change message for the deletion (the Git commit message on GitHub)"),
};

export async function handleVaultDelete(params: { path: string; message?: string | undefined }) {
  const result = await getVaultBackend().delete(params.path, { message: params.message });

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
