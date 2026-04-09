import { getInstanceConfig } from "@/core/config";
import { z } from "zod";
import { searchDrive } from "../lib/drive";

export const driveSearchSchema = {
  query: z.string().describe("Search query — file name or content keywords"),
  max_results: z.number().optional().describe("Max results (default: 10, max: 20)"),
};

export async function handleDriveSearch(params: {
  query: string;
  max_results?: number;
}) {
  const files = await searchDrive(params);

  if (files.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No files found for "${params.query}".` }],
    };
  }

  const typeLabels: Record<string, string> = {
    "application/vnd.google-apps.document": "Doc",
    "application/vnd.google-apps.spreadsheet": "Sheet",
    "application/vnd.google-apps.presentation": "Slides",
    "application/vnd.google-apps.folder": "Folder",
    "application/pdf": "PDF",
  };

  const lines = files.map((f) => {
    const type = typeLabels[f.mimeType] || f.mimeType.split("/").pop();
    const date = new Date(f.modifiedTime).toLocaleDateString(getInstanceConfig().locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const size = f.size ? ` (${Math.round(Number(f.size) / 1024)}KB)` : "";
    return `[${type}] ${f.name}${size} — ${date} (id:${f.id})\n  ${f.webViewLink}`;
  });

  return {
    content: [{ type: "text" as const, text: lines.join("\n\n") }],
  };
}
