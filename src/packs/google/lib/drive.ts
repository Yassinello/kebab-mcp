import { googleFetch, googleFetchJSON } from "./google-fetch";

const DRIVE = "https://www.googleapis.com/drive/v3";

// --- Google API response types ---

interface DriveFileListResponse {
  files?: {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
    webViewLink?: string;
    size?: string;
    owners?: { displayName?: string; emailAddress?: string }[];
  }[];
}

interface DriveFileMetadata {
  name: string;
  mimeType: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink: string;
  size?: string;
  owners?: string[];
}

export async function searchDrive(opts: {
  query: string;
  maxResults?: number;
}): Promise<DriveFile[]> {
  const limit = Math.min(opts.maxResults || 10, 20);
  const q = `(name contains '${opts.query.replace(/'/g, "\\'")}' or fullText contains '${opts.query.replace(/'/g, "\\'")}') and trashed = false`;

  const data = await googleFetchJSON<DriveFileListResponse>(
    `${DRIVE}/files?q=${encodeURIComponent(q)}&pageSize=${limit}` +
      `&fields=files(id,name,mimeType,modifiedTime,webViewLink,size,owners)` +
      `&orderBy=modifiedTime desc`
  );

  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    webViewLink: f.webViewLink || "",
    size: f.size,
    owners: (f.owners || []).map((o) => o.displayName || o.emailAddress || ""),
  }));
}

export async function readDriveFile(fileId: string): Promise<{ name: string; content: string; mimeType: string }> {
  const meta = await googleFetchJSON<DriveFileMetadata>(`${DRIVE}/files/${fileId}?fields=name,mimeType`);
  const mimeType = meta.mimeType || "";

  // Google Docs/Sheets/Slides → export as text
  const exportMap: Record<string, string> = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
  };

  if (exportMap[mimeType]) {
    const res = await googleFetch(
      `${DRIVE}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMap[mimeType])}`
    );
    return { name: meta.name, content: await res.text(), mimeType };
  }

  // Regular text files — download content
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    const res = await googleFetch(`${DRIVE}/files/${fileId}?alt=media`);
    return { name: meta.name, content: await res.text(), mimeType };
  }

  // Binary files — return metadata only
  return {
    name: meta.name,
    content: `[Binary file: ${meta.name} (${mimeType}). Use webViewLink to open in browser.]`,
    mimeType,
  };
}
