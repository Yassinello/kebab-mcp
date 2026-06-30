import { z } from "zod";
import { readDriveFile } from "../lib/drive";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const driveReadSchema = {
  file_id: z.string().describe("Google Drive file ID (from drive_search results)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleDriveRead(params: { file_id: string; account?: string | undefined }) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const file = await readDriveFile(r.ctx, params.file_id);

  const typeLabels: Record<string, string> = {
    "application/vnd.google-apps.document": "Google Doc",
    "application/vnd.google-apps.spreadsheet": "Google Sheet (CSV)",
    "application/vnd.google-apps.presentation": "Google Slides",
  };
  const type = typeLabels[file.mimeType] || file.mimeType;

  // Truncate very large files
  const maxLen = 50_000;
  const content =
    file.content.length > maxLen
      ? file.content.slice(0, maxLen) +
        `\n\n... [truncated at ${maxLen} chars, total: ${file.content.length}]`
      : file.content;

  return {
    content: [
      {
        type: "text" as const,
        text: `📄 ${file.name} (${type})\n---\n${content}`,
      },
    ],
  };
}
