/**
 * VLT-01 (Kebab House phase 2): the storage interface behind the 13 vault
 * tools, the `vault://` resources and `my_context` in vault mode.
 *
 * Two implementations:
 *   - `github` (VLT-02) — the original GitHub Contents/Trees/Commits code
 *     (`./github.ts`) behind this interface. Tool outputs are unchanged.
 *   - `kv` (VLT-03) — notes in the tenant-scoped KV store (Upstash or the
 *     filesystem KV), one key per note plus an index (`./kv-backend.ts`).
 *
 * Selection (VLT-04) lives in `./select.ts`.
 *
 * The interface is shaped by what the tools need, not by either storage:
 *   - `read` / `write` / `delete` / `move` — one note at a time. `write` and
 *     `delete` take an optional `expectedVersion` (the `sha` returned by
 *     `read`): GitHub enforces it server-side (409 on mismatch), the KV
 *     backend compares it with the stored note's version.
 *   - `list` — direct children of a folder; `tree` — every file under it.
 *   - `search`, `recent`, `stats`, `health`.
 *   - `linkCandidates` / `dueCandidates` — optional narrowing hints. A
 *     backend that keeps an index (KV) answers them so `vault_backlinks` and
 *     `vault_due` read a handful of notes instead of the whole vault; when
 *     absent (GitHub) the tools scan the tree exactly as before.
 */
import type { Provenance } from "./provenance";

export type VaultBackendKind = "github" | "kv";

export interface VaultFile {
  path: string;
  name: string;
  /** Version of the note: the git blob SHA on both backends. */
  sha: string;
  content: string;
  size: number;
}

export interface VaultListEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
}

export interface TreeFile {
  path: string;
  size: number;
  /** Git blob SHA when the backend knows it (used by the GitHub → KV import). */
  sha?: string;
}

export interface SearchResult {
  name: string;
  path: string;
  textMatches: string[];
  /** TRU-03: set when the backend already knows the note's provenance. */
  provenance?: Provenance;
}

export interface SearchOptions {
  folder?: string | undefined;
  limit: number;
  page: number;
}

export interface SearchOutcome {
  results: SearchResult[];
  totalCount: number;
  method: "github_search" | "tree_grep" | "kv_index";
  /** KV only: the content scan stopped at its cap; more matches may exist. */
  truncated?: boolean;
}

export interface RecentNote {
  path: string;
  message: string;
  date: string;
  author: string;
}

export interface RecentOptions {
  folder?: string | undefined;
  since?: string | undefined;
}

export interface WriteOptions {
  /** Commit message (GitHub) or change note (KV, shown by vault_recent). */
  message?: string | undefined;
  /** Optimistic concurrency: the version (`sha`) the caller last read. */
  expectedVersion?: string | undefined;
}

export interface WriteResult {
  path: string;
  sha: string;
  created: boolean;
  /** KV only: soft-limit warning (vault above the recommended total size). */
  warning?: string;
}

export interface MoveResult {
  from: string;
  to: string;
  /** Set when the note was copied but the original could not be removed. */
  deleteError?: string;
}

export interface VaultStats {
  totalNotes: number;
  totalSize: number;
  folderCounts: Record<string, number>;
  /** KV only: soft-limit warning. */
  warning?: string;
}

export interface VaultHealth {
  ok: boolean;
  backend: VaultBackendKind;
  message: string;
  details?: Record<string, unknown>;
}

export interface VaultBackend {
  readonly kind: VaultBackendKind;
  read(path: string): Promise<VaultFile>;
  write(path: string, content: string, opts?: WriteOptions): Promise<WriteResult>;
  delete(path: string, opts?: WriteOptions): Promise<{ path: string }>;
  move(from: string, to: string, opts?: { message?: string | undefined }): Promise<MoveResult>;
  list(folder?: string): Promise<VaultListEntry[]>;
  tree(folder?: string): Promise<TreeFile[]>;
  search(query: string, opts: SearchOptions): Promise<SearchOutcome>;
  recent(limit: number, opts?: RecentOptions): Promise<RecentNote[]>;
  stats(folder?: string): Promise<VaultStats>;
  health(): Promise<VaultHealth>;
  /** Paths of notes that may link to `path` (superset). Absent → scan the tree. */
  linkCandidates?(path: string): Promise<string[]>;
  /** Paths of notes under `folder` that declare `resurface`. Absent → scan the tree. */
  dueCandidates?(folder?: string): Promise<string[]>;
}

/**
 * Notes per folder, total size — the `vault_stats` computation, shared by
 * both backends so the numbers mean the same thing. Only `.md` files count.
 */
export function computeStats(tree: TreeFile[]): VaultStats {
  const folderCounts: Record<string, number> = {};
  let totalNotes = 0;
  let totalSize = 0;
  for (const file of tree) {
    if (!file.path.endsWith(".md")) continue;
    totalNotes++;
    totalSize += file.size || 0;
    const folder = file.path.includes("/") ? file.path.split("/").slice(0, -1).join("/") : "(root)";
    folderCounts[folder] = (folderCounts[folder] || 0) + 1;
  }
  return { totalNotes, totalSize, folderCounts };
}
