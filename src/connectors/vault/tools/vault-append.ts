import { z } from "zod";
import { getVaultBackend } from "../lib/select";
import { ensureProvenance, noteProvenance } from "../lib/provenance";

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
  separator?: string | undefined;
}) {
  const separator = params.separator ?? "\n\n";

  // Read existing file (get content + SHA in one call)
  const vault = getVaultBackend();
  const file = await vault.read(params.path);

  // Append content. TRU-03: the note now holds model-written text, so it is
  // tagged `provenance: assistant` unless it already declares a provenance
  // (an `external` article stays `external`, an explicit value is kept).
  const newContent = ensureProvenance(file.content + separator + params.content, "assistant");

  // Write back with known SHA (skips extra GET)
  const result = await vault.write(params.path, newContent, {
    message: `Append to ${params.path} via Kebab MCP`,
    expectedVersion: file.sha,
  });

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
            provenance: noteProvenance(newContent),
          },
          null,
          2
        ),
      },
    ],
  };
}
