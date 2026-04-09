import { z } from "zod";
import { vaultRead, vaultWrite, vaultDelete } from "../lib/github";

export const vaultMoveSchema = {
  from: z.string().describe("Current path, e.g. Inbox/note.md"),
  to: z.string().describe("New path, e.g. Veille/note.md"),
  message: z
    .string()
    .optional()
    .describe("Git commit message"),
};

export async function handleVaultMove(params: {
  from: string;
  to: string;
  message?: string;
}) {
  const commitMsg =
    params.message || `Move ${params.from} → ${params.to} via MyMCP`;

  // Step 1: Read source (gets content + SHA in one call)
  const source = await vaultRead(params.from);

  // Step 2: Write to new location
  await vaultWrite(params.to, source.content, commitMsg);

  // Step 3: Delete source using known SHA (saves one GET call)
  try {
    await vaultDelete(params.from, commitMsg, source.sha);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
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
