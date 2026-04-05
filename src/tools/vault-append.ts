import { z } from "zod";
import { vaultRead, vaultWrite } from "@/lib/github";

export const vaultAppendSchema = {
  path: z.string().describe("Path to the note, e.g. Journal/2026-04-01.md"),
  content: z.string().describe("Content to append at the end of the note"),
  separator: z
    .string()
    .optional()
    .describe('Separator before appended content (default: "\\n\\n")'),
};

export async function handleVaultAppend(params: {
  path: string;
  content: string;
  separator?: string;
}) {
  const separator = params.separator ?? "\n\n";

  // Read existing file (get content + SHA in one call)
  const file = await vaultRead(params.path);

  // Append content
  const newContent = file.content + separator + params.content;

  // Write back with known SHA (skips extra GET)
  const result = await vaultWrite(
    params.path,
    newContent,
    `Append to ${params.path} via YassMCP`,
    file.sha
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            path: result.path,
            sha: result.sha,
            appendedLength: params.content.length,
          },
          null,
          2
        ),
      },
    ],
  };
}
