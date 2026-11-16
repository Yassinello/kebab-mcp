/**
 * VLT-05 (Kebab House phase 2): vault path validation, shared by every
 * backend (GitHub and KV) so a path accepted by one is accepted by the other.
 *
 * - Reads, listings and folders: `validateVaultPath` (no empty path, no
 *   `..`, no leading `/`, no NUL byte).
 * - Writes, deletes and moves: `validateVaultWritePath` additionally refuses
 *   repository plumbing (`.git*`, `.github/`) — SEC-14. On the KV backend
 *   there is no repository, but keeping the rule identical means a vault can
 *   move between backends (import, export) without surprises.
 */

export function validateVaultPath(path: string): void {
  if (!path || path.trim().length === 0) {
    throw new Error("Path cannot be empty");
  }
  if (path.includes("..")) {
    throw new Error("Path cannot contain '..' (directory traversal)");
  }
  if (path.startsWith("/")) {
    throw new Error("Path must be relative (no leading /)");
  }
  if (/\0/.test(path)) {
    throw new Error("Path cannot contain null bytes");
  }
}

/**
 * SEC-14 (2026-11 audit): writes and deletes may not touch repository
 * plumbing. A prompt-injected `vault_write` to `.github/workflows/x.yml`
 * would otherwise run arbitrary code in GitHub Actions when the PAT has the
 * `workflow` scope.
 */
export function validateVaultWritePath(path: string): void {
  validateVaultPath(path);
  const first = (path.split("/")[0] ?? "").toLowerCase();
  if (first === ".github" || first.startsWith(".git")) {
    throw new Error(`Writing under '${first}/' is not allowed (repository configuration)`);
  }
}

/** `Veille/` and `Veille` name the same folder; the root is the empty string. */
export function normalizeFolder(folder: string | undefined): string {
  return (folder ?? "").replace(/\/+$/, "");
}

/** True when `path` lives under `folder` (any depth). The root contains everything. */
export function isUnderFolder(path: string, folder: string): boolean {
  return folder === "" || path.startsWith(folder + "/");
}

/** Last path segment. */
export function baseName(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * The last path segment ends with an extension (`.md`, `.txt`, `.canvas`).
 * A dot followed by digits only (`v2.0`, `2026.11.15`) is not an extension.
 */
export function hasExtension(path: string): boolean {
  return /\.[a-z][a-z0-9]{0,9}$/i.test(baseName(path));
}

/** A Markdown note: `.md`, or a path saved without any extension. */
export function isNotePath(path: string): boolean {
  return path.toLowerCase().endsWith(".md") || !hasExtension(path);
}

/**
 * B1 (2026-11 audit): a note saved as `Inbox/2026-11-15` (no extension) was
 * invisible to vault_recent, vault_stats, the export and the status card,
 * which only consider `.md` files. Writes now add `.md` when the last
 * segment has no extension. Returns the path to use and whether it changed.
 */
export function withMarkdownExtension(path: string): { path: string; added: boolean } {
  if (!path || path.endsWith("/") || hasExtension(path)) return { path, added: false };
  return { path: `${path}.md`, added: true };
}
