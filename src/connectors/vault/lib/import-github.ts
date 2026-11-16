/**
 * VLT-06 (Kebab House phase 2): copy a GitHub vault into the KV backend.
 *
 * - Markdown files only (`.md`); everything else is reported as skipped.
 * - Notes over the KV limit (256 KB) are reported as too large.
 * - Paths the vault refuses to write (`.git*`, `.github/`) are skipped.
 * - A note already in the KV with the same version (git blob SHA — the KV
 *   backend uses the same scheme) is left alone, so running the import again
 *   only copies what changed: an import cut short by the time budget resumes
 *   where it stopped.
 * - B2 (2026-11 audit): a note that exists in both with DIFFERENT content
 *   is kept as it is in the KV (it may hold edits made since) unless the
 *   caller passes `overwrite: true` — the dashboard asks for confirmation.
 *   Before, one click silently replaced every such note.
 * - KV notes absent from GitHub are kept (the import never deletes).
 *
 * The import does NOT switch backend: the vault keeps following
 * `KEBAB_VAULT_BACKEND` / the GitHub credentials (see `./select.ts`).
 */
import { toMsg } from "@/core/error-utils";
import { vaultRead, vaultTree } from "./github";
import { kvVaultBackend, KV_VAULT_LIMITS, type KvVaultBackend } from "./kv-backend";
import { validateVaultWritePath } from "./paths";
import { githubVaultConfigured } from "./select";

const LIST_CAP = 200;
const BATCH = 25;

export interface VaultImportReport {
  totalFiles: number;
  /** New notes copied into the KV. */
  copied: number;
  /** Notes that existed in the KV with other content and were replaced (overwrite). */
  overwritten: number;
  /** Notes that exist in both with different content, left as they are in the KV. */
  keptCount: number;
  unchanged: number;
  skippedCount: number;
  tooLargeCount: number;
  failedCount: number;
  /** Time budget reached: run the import again to copy the rest. */
  incomplete: boolean;
  remaining: number;
  /** Detail lists, capped at 200 entries each. */
  copiedPaths: string[];
  overwrittenPaths: string[];
  kept: string[];
  skipped: Array<{ path: string; reason: string }>;
  tooLarge: Array<{ path: string; size: number }>;
  failed: Array<{ path: string; error: string }>;
}

export class VaultImportConfigError extends Error {}

function push<T>(list: T[], item: T): void {
  if (list.length < LIST_CAP) list.push(item);
}

export async function importGithubVaultToKv(
  opts: {
    kv?: KvVaultBackend;
    timeBudgetMs?: number;
    concurrency?: number;
    now?: () => number;
    /** Replace KV notes that differ from GitHub (default: keep them). */
    overwrite?: boolean;
  } = {}
): Promise<VaultImportReport> {
  if (!githubVaultConfigured()) {
    throw new VaultImportConfigError(
      "GitHub vault not configured: set GITHUB_PAT and GITHUB_REPO (Connectors → Memory Vault) to import it."
    );
  }
  const kv = opts.kv ?? kvVaultBackend;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeBudgetMs ?? 45_000);
  const concurrency = Math.max(1, opts.concurrency ?? 6);

  const report: VaultImportReport = {
    totalFiles: 0,
    copied: 0,
    overwritten: 0,
    keptCount: 0,
    unchanged: 0,
    skippedCount: 0,
    tooLargeCount: 0,
    failedCount: 0,
    incomplete: false,
    remaining: 0,
    copiedPaths: [],
    overwrittenPaths: [],
    kept: [],
    skipped: [],
    tooLarge: [],
    failed: [],
  };
  const skip = (path: string, reason: string) => {
    report.skippedCount++;
    push(report.skipped, { path, reason });
  };
  const keep = (path: string) => {
    report.keptCount++;
    push(report.kept, path);
  };
  const tooLarge = (path: string, size: number) => {
    report.tooLargeCount++;
    push(report.tooLarge, { path, size });
  };

  const tree = await vaultTree();
  report.totalFiles = tree.length;
  const versions = await kv.versions();

  const toCopy: string[] = [];
  for (const file of tree) {
    if (!file.path.toLowerCase().endsWith(".md")) {
      skip(file.path, "not_markdown");
      continue;
    }
    try {
      validateVaultWritePath(file.path);
    } catch {
      skip(file.path, "reserved_path");
      continue;
    }
    if (file.size > KV_VAULT_LIMITS.maxNoteBytes) {
      tooLarge(file.path, file.size);
      continue;
    }
    const local = versions[file.path];
    if (file.sha && local === file.sha) {
      report.unchanged++;
      continue;
    }
    // In both, different content: keep the KV copy unless asked (no fetch).
    if (local !== undefined && !opts.overwrite) {
      keep(file.path);
      continue;
    }
    toCopy.push(file.path);
  }

  let next = 0;
  while (next < toCopy.length) {
    if (now() >= deadline) break;
    const batch = toCopy.slice(next, next + BATCH);
    next += batch.length;

    // Fetch the batch from GitHub, `concurrency` files at a time.
    const fetched: Array<{ path: string; content: string }> = [];
    for (let i = 0; i < batch.length; i += concurrency) {
      const slice = batch.slice(i, i + concurrency);
      const results = await Promise.allSettled(slice.map((p) => vaultRead(p)));
      results.forEach((r, j) => {
        const path = slice[j]!;
        if (r.status === "fulfilled") fetched.push({ path, content: r.value.content });
        else {
          report.failedCount++;
          push(report.failed, { path, error: toMsg(r.reason) });
        }
      });
    }

    const res = await kv.importNotes(fetched, "Imported from GitHub", {
      overwrite: opts.overwrite === true,
    });
    report.copied += res.written.length;
    for (const p of res.written) push(report.copiedPaths, p);
    report.overwritten += res.overwritten.length;
    for (const p of res.overwritten) push(report.overwrittenPaths, p);
    report.unchanged += res.unchanged.length;
    // Created in the KV meanwhile (or not indexed yet) with other content.
    for (const p of res.kept) keep(p);
    const rejected = res.rejected;
    for (const r of rejected) {
      if (r.reason === "too_large") {
        const n = fetched.find((f) => f.path === r.path);
        tooLarge(r.path, n ? Buffer.byteLength(n.content, "utf8") : 0);
      } else {
        skip(r.path, r.reason);
      }
    }
  }

  report.remaining = toCopy.length - next;
  report.incomplete = report.remaining > 0;
  return report;
}
