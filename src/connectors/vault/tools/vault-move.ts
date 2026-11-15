import { z } from "zod";
import { getVaultBackend } from "../lib/select";

export const vaultMoveSchema = {
  from: z.string().describe("Current path, e.g. Inbox/note.md"),
  to: z.string().describe("New path, e.g. Veille/note.md"),
  message: z.string().optional().describe("Change message (the Git commit message on GitHub)"),
};

export async function handleVaultMove(params: {
  from: string;
  to: string;
  message?: string | undefined;
}) {
  const commitMsg = params.message || `Move ${params.from} → ${params.to} via Kebab MCP`;

  const result = await getVaultBackend().move(params.from, params.to, { message: commitMsg });

  if (result.deleteError !== undefined) {
    const msg = result.deleteError;
    // Write succeeded but delete failed — note is duplicated
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              action: "partial_move",
              from: params.from,
              to: params.to,
              warning: `Note copied to ${params.to} but failed to delete original: ${msg}. Manual cleanup needed.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { success: true, action: "moved", from: params.from, to: params.to },
          null,
          2
        ),
      },
    ],
  };
}
