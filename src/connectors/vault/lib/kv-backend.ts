/**
 * VLT-03 (Kebab House phase 2): the vault stored in the tenant-scoped KV
 * store (`getContextKVStore()` — Upstash in production, the filesystem KV
 * in Docker / `npm run dev`). No GitHub needed.
 *
 * Layout:
 *   - `vault:note:<path>` → JSON `{ content, mtime, size, message? }`
 *   - `vault:index`       → JSON `{ v: 1, notes: { <path>: IndexEntry } }`
 *     with the title, mtime, size, version (git blob SHA), outgoing
 *     `[[links]]`, provenance and a `resurface` flag of every note. Listing,
 *     tree, search, recent, stats, backlinks and due all start from the
 *     index; only search (content pass) and the tools' own reads touch notes.
 *
 * Limits: 256 KB per note, 5 000 notes (hard); a warning above 50 MB total.
 *
 * Index consistency
 * -----------------
 * Every write/delete/move stores the note key first, then commits the index
 * (read-modify-write). The KV interface has no transactions, so:
 *   - mutations are serialised inside one process (an in-process lock), so
 *     parallel tool calls landing on the same instance never race;
 *   - across instances (serverless, Upstash) each index save first claims
 *     the next index revision with an atomic SET NX
 *     (`vault:index:rev:<n>`, short TTL). Two writers that read the same
 *     index revision cannot both save it: the loser re-reads the index —
 *     which now holds the winner's entry — re-applies its own change and
 *     claims the next revision (B2, 2026-11 audit). A claim whose writer
 *     died before saving is outlived by a rebuild from the note keys after a
 *     few attempts. On the filesystem KV (one process) the lock suffices;
 *   - self-healing: reads (list, tree, search, recent, stats) compare the
 *     note keys with the index at most every few minutes per instance, and
 *     the full export always does; missing entries are added from their
 *     note, entries without a note are dropped. The index can also be
 *     rebuilt from scratch: automatically when it is missing or unreadable,
 *     when a mutation finds a stored note the index does not know (drift),
 *     and manually from /config → Connectors → Memory Vault → "Rebuild index".
 * A lost index entry never loses the note itself: `vault_read` reads the
 * note key directly.
 */
import { createHash } from "node:crypto";
import { getContextKVStore } from "@/core/request-context";
import { kvScanAll, type KVStore } from "@/core/kv-store";
import { VaultConflictError, VaultLimitError, VaultNotFoundError } from "@/core/connector-errors";
import { BRAND, PRODUCT } from "@/core/constants/brand";
import { toMsg } from "@/core/error-utils";
import { runAfterResponse } from "@/core/after-response";
import { parseNoteFrontmatter, provenanceOf, type Provenance } from "./provenance";
import {
  baseName,
  hasExtension,
  isNotePath,
  isUnderFolder,
  normalizeFolder,
  validateVaultPath,
  validateVaultWritePath,
} from "./paths";
import {
  bestSnippet,
  foldText,
  queryTerms,
  scoreNote,
  searchable,
  termMatches,
  type Searchable,
} from "./search-rank";
import {
  computeStats,
  destinationExistsError,
  type MoveOptions,
  type SearchResult,
  type TreeFile,
  type VaultBackend,
  type VaultFile,
  type VaultListEntry,
  type WriteOptions,
} from "./backend";

export const NOTE_PREFIX = "vault:note:";
export const INDEX_KEY = "vault:index";
/** Index revision claims (SET NX, short TTL). Under `vault:index` → never exported. */
export const INDEX_CLAIM_PREFIX = "vault:index:rev:";

export const KV_VAULT_LIMITS = {
  maxNoteBytes: 256 * 1024,
  maxNotes: 5000,
  warnTotalBytes: 50 * 1024 * 1024,
} as const;

/** Search caps: results kept, and how much note content one search may scan. */
const SEARCH_MAX_RESULTS = 200;
const SEARCH_MAX_SCAN_NOTES = 2000;
const SEARCH_MAX_SCAN_BYTES = 16 * 1024 * 1024;
const READ_CHUNK = 50;
const MAX_LINKS_PER_NOTE = 500;
const MAX_MESSAGE_CHARS = 200;
const DEFAULT_MESSAGE = `Update via ${BRAND.displayName}`;

interface StoredNote {
  content: string;
  mtime: string;
  size: number;
  message?: string;
}

interface IndexEntry {
  title: string;
  mtime: string;
  size: number;
  /** Git blob SHA of the content — the note's version. */
  sha: string;
  /** Outgoing wikilink targets (`[[target]]`, `[[target|alias]]`), without `#heading` / `.md`. */
  links: string[];
  /** Omitted when `user`. */
  prov?: Provenance;
  /** The frontmatter declares `resurface` (vault_due). */
  due?: true;
  /** Last change message (vault_recent). */
  msg?: string;
}

interface VaultIndex {
  v: 1;
  notes: Record<string, IndexEntry>;
  /** Revision, bumped on every save (claimed with SET NX on shared stores). */
  rev?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function noteKey(path: string): string {
  return NOTE_PREFIX + path;
}

/** Same version scheme as GitHub (`git hash-object`), so imported notes keep their SHA. */
export function blobSha(content: string): string {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export { foldText };

function bodyOf(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  return end === -1 ? content : content.slice(end + 4);
}

function extractTitle(path: string, content: string, fm: Record<string, unknown> | null): string {
  const t = fm?.title;
  if (typeof t === "string" && t.trim()) return t.trim().slice(0, 300);
  const h1 = /^#\s+(.+)$/m.exec(bodyOf(content));
  if (h1?.[1]?.trim()) return h1[1].trim().slice(0, 300);
  return baseName(path).replace(/\.md$/, "");
}

/** Outgoing wikilinks, normalised to their target note (no alias, heading or `.md`). */
export function extractLinks(content: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null && out.size < MAX_LINKS_PER_NOTE) {
    const target = (m[1] ?? "").split("#")[0]!.trim().replace(/\.md$/, "");
    if (target) out.add(target);
  }
  return [...out];
}

function entryFor(path: string, note: StoredNote): IndexEntry {
  const fm = parseNoteFrontmatter(note.content);
  const prov = provenanceOf(fm);
  const entry: IndexEntry = {
    title: extractTitle(path, note.content, fm),
    mtime: note.mtime,
    size: note.size,
    sha: blobSha(note.content),
    links: extractLinks(note.content),
  };
  if (prov !== "user") entry.prov = prov;
  if (fm && fm.resurface !== undefined && fm.resurface !== null && fm.resurface !== "") {
    entry.due = true;
  }
  if (note.message) entry.msg = note.message;
  return entry;
}

function parseNote(raw: string | null): StoredNote | null {
  if (raw === null) return null;
  try {
    const n = JSON.parse(raw) as Partial<StoredNote>;
    if (typeof n.content !== "string") return null;
    return {
      content: n.content,
      mtime: typeof n.mtime === "string" ? n.mtime : new Date(0).toISOString(),
      size: typeof n.size === "number" ? n.size : Buffer.byteLength(n.content, "utf8"),
      ...(typeof n.message === "string" && n.message ? { message: n.message } : {}),
    };
  } catch {
    return null;
  }
}

function parseIndex(raw: string | null): VaultIndex | null {
  if (raw === null) return null;
  try {
    const idx = JSON.parse(raw) as Partial<VaultIndex>;
    if (idx.v !== 1 || !idx.notes || typeof idx.notes !== "object") return null;
    return idx as VaultIndex;
  } catch {
    return null;
  }
}

async function getMany(kv: KVStore, keys: string[]): Promise<(string | null)[]> {
  if (keys.length === 0) return [];
  if (typeof kv.mget === "function") return kv.mget(keys);
  return Promise.all(keys.map((k) => kv.get(k)));
}

function totalBytes(index: VaultIndex): number {
  let total = 0;
  for (const e of Object.values(index.notes)) total += e.size;
  return total;
}

function sizeWarning(index: VaultIndex): string | undefined {
  const total = totalBytes(index);
  if (total <= KV_VAULT_LIMITS.warnTotalBytes) return undefined;
  const mb = Math.round(total / 1024 / 1024);
  return (
    `The vault holds ${mb} MB, above the recommended 50 MB for the KV backend. ` +
    `Consider the GitHub backend for a vault this large.`
  );
}

function checkNoteSize(path: string, bytes: number): void {
  if (bytes > KV_VAULT_LIMITS.maxNoteBytes) {
    throw new VaultLimitError(
      `Note too large for the KV vault: ${path} is ${Math.ceil(bytes / 1024)} KB ` +
        `(max ${KV_VAULT_LIMITS.maxNoteBytes / 1024} KB).`
    );
  }
}

function noteLimitError(): VaultLimitError {
  return new VaultLimitError(
    `The KV vault is full (${KV_VAULT_LIMITS.maxNotes} notes). Delete notes or switch to the GitHub backend.`
  );
}

function validateKvWritePath(path: string): void {
  validateVaultWritePath(path);
  // GitHub refuses these implicitly (a file cannot be named like a folder);
  // the KV store would happily accept them, so refuse them here.
  if (path.endsWith("/")) throw new Error("Path must name a note, not a folder (trailing /)");
}

function cleanMessage(message: string | undefined): string {
  const m = (message ?? "").split("\n")[0]!.trim();
  return (m || DEFAULT_MESSAGE).slice(0, MAX_MESSAGE_CHARS);
}

function sortedEntries(index: VaultIndex, folder: string): Array<[string, IndexEntry]> {
  return Object.entries(index.notes)
    .filter(([p]) => isUnderFolder(p, folder))
    .sort(([, a], [, b]) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
}

/**
 * Modification time, strictly increasing within the process so two writes in
 * the same millisecond still have a defined order for vault_recent.
 */
let lastMtimeMs = 0;
function nextMtime(): string {
  lastMtimeMs = Math.max(Date.now(), lastMtimeMs + 1);
  return new Date(lastMtimeMs).toISOString();
}

// ── Index commits, self-healing ──────────────────────────────────────

/** Lifetime of an index revision claim: far longer than one read-modify-write. */
const CLAIM_TTL_S = 600;
/** Claim attempts before falling back to a rebuild from the note keys. */
const COMMIT_ATTEMPTS = 8;
/** Reads compare the note keys with the index at most this often (per instance). */
const HEAL_INTERVAL_MS = 5 * 60_000;
const SCAN_PAGE = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A store shared by several instances (Upstash): index saves are claimed.
 * The filesystem KV lives in one process, where the in-process lock is
 * enough and a claim would only cost an extra file write.
 */
function needsClaims(kv: KVStore): boolean {
  return kv.kind === "upstash" && typeof kv.setIfNotExists === "function";
}

/** The scan for note keys ran past its time budget: the repair is skipped. */
class ScanBudgetExceeded extends Error {}

/**
 * Time budget for the background index repair. A Redis SCAN walks the whole
 * keyspace, one HTTP round trip per page on Upstash: on a large instance a
 * full scan can take longer than the function itself may run.
 */
export const HEAL_SCAN_BUDGET_MS = 8_000;

/** Every stored note key (deduplicated: a Redis SCAN may repeat keys). */
async function noteKeys(kv: KVStore, budgetMs?: number): Promise<string[]> {
  const deadline = budgetMs ? Date.now() + budgetMs : Infinity;
  if (typeof kv.scan !== "function") {
    return (await kvScanAll(kv, `${NOTE_PREFIX}*`)).filter((k) => k.startsWith(NOTE_PREFIX));
  }
  const out = new Set<string>();
  let cursor = "0";
  let guard = 0;
  do {
    const page = await kv.scan(cursor, { match: `${NOTE_PREFIX}*`, count: SCAN_PAGE });
    for (const k of page.keys) if (k.startsWith(NOTE_PREFIX)) out.add(k);
    cursor = page.cursor;
    guard++;
    if (cursor !== "0" && Date.now() > deadline) throw new ScanBudgetExceeded();
  } while (cursor !== "0" && guard < 100_000);
  return [...out];
}

/** In `stats`, a note whose path has no extension counts like a `.md` note. */
function statsPath(path: string): string {
  return hasExtension(path) ? path : `${path}.md`;
}

// ── Backend ──────────────────────────────────────────────────────────

export interface ImportedNote {
  path: string;
  content: string;
}

export interface ImportNotesResult {
  /** Notes that did not exist and were created. */
  written: string[];
  /** Notes that existed with other content and were replaced (`overwrite: true`). */
  overwritten: string[];
  /** Notes that existed with other content and were left alone (default). */
  kept: string[];
  /** Notes that already hold exactly this content. */
  unchanged: string[];
  rejected: Array<{ path: string; reason: string }>;
}

export interface KvVaultBackend extends VaultBackend {
  /** Rebuild `vault:index` from the note keys. Returns the number of notes indexed. */
  rebuildIndex(): Promise<{ notes: number; totalBytes: number }>;
  /** Compare the note keys with the index now and repair it. */
  verifyIndex(): Promise<{ added: number; removed: number }>;
  /**
   * Write many notes with a single index update (GitHub → KV import).
   * Notes that already exist with other content are kept unless `overwrite`.
   */
  importNotes(
    notes: ImportedNote[],
    message: string,
    opts?: { overwrite?: boolean | undefined }
  ): Promise<ImportNotesResult>;
  /** Version (blob SHA) of every indexed note — lets an import skip unchanged notes. */
  versions(): Promise<Record<string, string>>;
}

export function createKvVaultBackend(getKv: () => KVStore = getContextKVStore): KvVaultBackend {
  // ── In-process lock (serialises mutations on one instance) ──────────
  let lockChain: Promise<unknown> = Promise.resolve();
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lockChain.then(fn, fn);
    lockChain = run.catch(() => undefined);
    return run;
  }

  let lastHealAt = 0;

  async function saveIndex(kv: KVStore, index: VaultIndex): Promise<void> {
    await kv.set(INDEX_KEY, JSON.stringify(index));
  }

  /** Rebuild from the note keys. Caller holds the lock (or accepts the race). */
  async function rebuild(kv: KVStore): Promise<VaultIndex> {
    const keys = await noteKeys(kv);
    const previous = parseIndex(await kv.get(INDEX_KEY));
    // A fresh revision far above any pending claim (see commitIndex).
    const index: VaultIndex = {
      v: 1,
      notes: {},
      rev: Math.max(Date.now(), (previous?.rev ?? 0) + 1),
    };
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const values = await getMany(kv, chunk);
      chunk.forEach((key, j) => {
        const note = parseNote(values[j] ?? null);
        if (note) {
          const path = key.slice(NOTE_PREFIX.length);
          index.notes[path] = entryFor(path, note);
        }
      });
    }
    await saveIndex(kv, index);
    return index;
  }

  /** Load the index; rebuild it when missing or unreadable. Caller holds the lock. */
  async function loadIndexLocked(kv: KVStore): Promise<VaultIndex> {
    return parseIndex(await kv.get(INDEX_KEY)) ?? rebuild(kv);
  }

  /** Load the index for a read path (takes the lock only to rebuild). */
  async function loadIndex(kv: KVStore): Promise<VaultIndex> {
    const idx = parseIndex(await kv.get(INDEX_KEY));
    if (idx) return idx;
    return withLock(() => loadIndexLocked(kv));
  }

  /**
   * Apply `mutate` to the latest index and save it. Caller holds the lock.
   *
   * On a shared store each save first claims revision `rev + 1` with SET NX.
   * Losing the claim means another instance saved (or is saving) that
   * revision from the same base: re-read, re-apply, claim the next one. So
   * `mutate` must be safe to apply again to a newer index. `first` is an
   * index the caller already loaded (saves one read on the first attempt).
   */
  async function commitIndex(
    kv: KVStore,
    mutate: (index: VaultIndex) => void,
    first?: VaultIndex
  ): Promise<VaultIndex> {
    if (!needsClaims(kv)) {
      const index = first ?? (await loadIndexLocked(kv));
      mutate(index);
      index.rev = (index.rev ?? 0) + 1;
      await saveIndex(kv, index);
      return index;
    }
    let candidate = first;
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      const index = candidate ?? (await loadIndexLocked(kv));
      candidate = undefined;
      const rev = (index.rev ?? 0) + 1;
      mutate(index);
      const claim = await kv.setIfNotExists!(`${INDEX_CLAIM_PREFIX}${rev}`, String(Date.now()), {
        ttlSeconds: CLAIM_TTL_S,
      });
      if (claim.ok) {
        index.rev = rev;
        await saveIndex(kv, index);
        return index;
      }
      await sleep(Math.min(200, 15 * 2 ** attempt) + Math.floor(Math.random() * 15));
    }
    // A writer claimed a revision and never saved it (it died in between):
    // the note keys are the truth, and the rebuild jumps past the claim.
    return rebuild(kv);
  }

  /**
   * Compare the stored note keys with the index; add the missing entries
   * (from their note) and drop entries whose note is gone.
   */
  async function heal(
    kv: KVStore,
    index: VaultIndex,
    budgetMs?: number
  ): Promise<{ index: VaultIndex; added: number; removed: number }> {
    const stored = new Set((await noteKeys(kv, budgetMs)).map((k) => k.slice(NOTE_PREFIX.length)));
    const missing = [...stored].filter((p) => !index.notes[p]);
    const stale = Object.keys(index.notes).filter((p) => !stored.has(p));
    if (missing.length === 0 && stale.length === 0) return { index, added: 0, removed: 0 };
    return withLock(async () => {
      const entries: Record<string, IndexEntry> = {};
      for (let i = 0; i < missing.length; i += 100) {
        const chunk = missing.slice(i, i + 100);
        const values = await getMany(kv, chunk.map(noteKey));
        chunk.forEach((p, j) => {
          const note = parseNote(values[j] ?? null);
          if (note) entries[p] = entryFor(p, note);
        });
      }
      // Re-check under the lock: a note written meanwhile is not stale.
      const staleValues = await getMany(kv, stale.map(noteKey));
      const gone = stale.filter((_, j) => staleValues[j] === null);
      if (Object.keys(entries).length === 0 && gone.length === 0) {
        return { index, added: 0, removed: 0 };
      }
      const saved = await commitIndex(kv, (idx) => {
        for (const [p, e] of Object.entries(entries)) if (!idx.notes[p]) idx.notes[p] = e;
        for (const p of gone) delete idx.notes[p];
      });
      return { index: saved, added: Object.keys(entries).length, removed: gone.length };
    });
  }

  /**
   * The index for a read. Every few minutes the index is also repaired from
   * the note keys — after the response and within a time budget, never
   * inline: on Upstash the scan walks the whole keyspace, and a large
   * instance made every first read of a fresh function run into the 90 s
   * limit (kebab-mcp-yass, 16 Nov 2026).
   */
  async function readIndex(kv: KVStore): Promise<VaultIndex> {
    const index = await loadIndex(kv);
    const now = Date.now();
    if (now - lastHealAt < HEAL_INTERVAL_MS) return index;
    lastHealAt = now;
    // fire-and-forget OK: best-effort repair of the note index; the read uses the stored index
    runAfterResponse(async () => {
      try {
        await heal(kv, index, HEAL_SCAN_BUDGET_MS);
      } catch (err) {
        if (!(err instanceof ScanBudgetExceeded)) throw err;
      }
    }, "vault.index.heal");
    return index;
  }

  async function readStored(kv: KVStore, path: string): Promise<StoredNote | null> {
    return parseNote(await kv.get(noteKey(path)));
  }

  function checkVersion(path: string, existing: StoredNote | null, expected?: string): void {
    if (!expected) return;
    if (!existing || blobSha(existing.content) !== expected) throw new VaultConflictError(path);
  }

  const backend: KvVaultBackend = {
    kind: "kv",

    async read(path: string): Promise<VaultFile> {
      validateVaultPath(path);
      const note = await readStored(getKv(), path);
      if (!note) throw new VaultNotFoundError(path);
      return {
        path,
        name: baseName(path),
        sha: blobSha(note.content),
        content: note.content,
        size: Buffer.byteLength(note.content, "utf8"),
      };
    },

    async write(path: string, content: string, opts?: WriteOptions) {
      validateKvWritePath(path);
      const size = Buffer.byteLength(content, "utf8");
      checkNoteSize(path, size);
      const kv = getKv();
      return withLock(async () => {
        const existing = await readStored(kv, path);
        checkVersion(path, existing, opts?.expectedVersion);
        let index = await loadIndexLocked(kv);
        // Drift: a stored note the index does not know → the index lost updates.
        if (existing && !index.notes[path]) index = await rebuild(kv);
        if (!existing && Object.keys(index.notes).length >= KV_VAULT_LIMITS.maxNotes) {
          throw noteLimitError();
        }
        const note: StoredNote = {
          content,
          mtime: nextMtime(),
          size,
          message: cleanMessage(opts?.message),
        };
        await kv.set(noteKey(path), JSON.stringify(note));
        const entry = entryFor(path, note);
        const saved = await commitIndex(
          kv,
          (idx) => {
            idx.notes[path] = entry;
          },
          index
        );
        const warning = sizeWarning(saved);
        return { path, sha: entry.sha, created: !existing, ...(warning ? { warning } : {}) };
      });
    },

    async delete(path: string, opts?: WriteOptions) {
      validateKvWritePath(path);
      const kv = getKv();
      return withLock(async () => {
        const existing = await readStored(kv, path);
        if (!existing) {
          // Drop a stale index entry, if any, before reporting.
          const index = await loadIndexLocked(kv);
          if (index.notes[path]) {
            await commitIndex(
              kv,
              (idx) => {
                delete idx.notes[path];
              },
              index
            );
          }
          throw new VaultNotFoundError(path);
        }
        checkVersion(path, existing, opts?.expectedVersion);
        await kv.delete(noteKey(path));
        const index = await loadIndexLocked(kv);
        if (index.notes[path]) {
          await commitIndex(
            kv,
            (idx) => {
              delete idx.notes[path];
            },
            index
          );
        } else {
          await rebuild(kv);
        }
        return { path };
      });
    },

    async move(from: string, to: string, opts?: MoveOptions) {
      validateKvWritePath(from);
      validateKvWritePath(to);
      if (from === to) throw new Error("Source and destination are the same path");
      const kv = getKv();
      return withLock(async () => {
        const source = await readStored(kv, from);
        if (!source) throw new VaultNotFoundError(from);
        // B2: never replace an existing note silently.
        if (!opts?.overwrite && (await readStored(kv, to))) throw destinationExistsError(to);
        const moved: StoredNote = {
          content: source.content,
          mtime: nextMtime(),
          size: source.size,
          message: cleanMessage(opts?.message ?? `Move ${from} → ${to}`),
        };
        // Write the copy first: if the delete fails the note is duplicated,
        // never lost.
        await kv.set(noteKey(to), JSON.stringify(moved));
        let deleteError: string | undefined;
        try {
          await kv.delete(noteKey(from));
        } catch (err) {
          deleteError = toMsg(err);
        }
        const index = await loadIndexLocked(kv);
        if (!index.notes[from]) {
          // Drift: the source was not indexed — rebuild from the notes.
          await rebuild(kv);
        } else {
          const entry = entryFor(to, moved);
          await commitIndex(
            kv,
            (idx) => {
              if (deleteError === undefined) delete idx.notes[from];
              idx.notes[to] = entry;
            },
            index
          );
        }
        return deleteError === undefined ? { from, to } : { from, to, deleteError };
      });
    },

    async list(folder?: string): Promise<VaultListEntry[]> {
      if (folder) validateVaultPath(folder);
      const f = normalizeFolder(folder);
      const index = await readIndex(getKv());
      const prefix = f ? `${f}/` : "";
      const files: VaultListEntry[] = [];
      const dirs = new Map<string, VaultListEntry>();
      for (const [path, e] of Object.entries(index.notes)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          files.push({ name: rest, path, type: "file", size: e.size });
        } else {
          const name = rest.slice(0, slash);
          if (!dirs.has(name)) dirs.set(name, { name, path: prefix + name, type: "dir", size: 0 });
        }
      }
      if (f && files.length === 0 && dirs.size === 0) {
        if (index.notes[f]) throw new Error(`Path is a file, not a directory: ${folder}`);
        throw new VaultNotFoundError(f);
      }
      return [...dirs.values(), ...files].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      );
    },

    async tree(folder?: string): Promise<TreeFile[]> {
      if (folder) validateVaultPath(folder);
      const f = normalizeFolder(folder);
      const index = await readIndex(getKv());
      return Object.entries(index.notes)
        .filter(([p]) => isUnderFolder(p, f))
        .map(([path, e]) => ({ path, size: e.size, sha: e.sha }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },

    async search(query, opts) {
      if (opts.folder) validateVaultPath(opts.folder);
      const terms = queryTerms(query);
      if (terms.length === 0) throw new Error("Search query is empty");
      const kv = getKv();
      const index = await readIndex(kv);
      const candidates = sortedEntries(index, normalizeFolder(opts.folder));

      interface Hit {
        path: string;
        e: IndexEntry;
        score: number;
        snippet: string;
      }
      const hits: Hit[] = [];
      const titleSnippet = (e: IndexEntry) => `Title match: ${e.title}`;

      // Pass 1: titles and file names, from the index alone. A note whose
      // title holds every term needs no content read.
      const toScan: Array<{ path: string; e: IndexEntry; title: Searchable; titleScore: number }> =
        [];
      for (const [path, e] of candidates) {
        const title = searchable(`${e.title}\n${baseName(path).replace(/\.md$/, "")}`);
        const t = scoreNote(terms, title, null);
        if (t.matched.length === terms.length) {
          hits.push({ path, e, score: t.score, snippet: titleSnippet(e) });
        } else {
          toScan.push({ path, e, title, titleScore: t.score });
        }
      }

      // Pass 2: contents, most recent first, capped in notes and bytes.
      // Notes beyond the cap still count through their title.
      let truncated = false;
      let scannedNotes = 0;
      let scannedBytes = 0;
      let i = 0;
      for (; i < toScan.length; i += READ_CHUNK) {
        if (scannedNotes >= SEARCH_MAX_SCAN_NOTES || scannedBytes >= SEARCH_MAX_SCAN_BYTES) break;
        const chunk = toScan.slice(i, i + READ_CHUNK);
        const values = await getMany(
          kv,
          chunk.map((c) => noteKey(c.path))
        );
        for (let j = 0; j < chunk.length; j++) {
          const c = chunk[j]!;
          const note = parseNote(values[j] ?? null);
          if (!note) {
            if (c.titleScore > 0) {
              hits.push({ path: c.path, e: c.e, score: c.titleScore, snippet: titleSnippet(c.e) });
            }
            continue;
          }
          scannedNotes++;
          scannedBytes += note.size;
          const content = searchable(note.content);
          const r = scoreNote(terms, c.title, content);
          if (r.score === 0) continue;
          const inContent = r.matched.filter((q) => termMatches(content, q));
          hits.push({
            path: c.path,
            e: c.e,
            score: r.score,
            snippet: inContent.length ? bestSnippet(note.content, inContent) : titleSnippet(c.e),
          });
        }
      }
      if (i < toScan.length) {
        truncated = true;
        for (const c of toScan.slice(i)) {
          if (c.titleScore > 0) {
            hits.push({ path: c.path, e: c.e, score: c.titleScore, snippet: titleSnippet(c.e) });
          }
        }
      }

      // Best score first, then most recent.
      hits.sort(
        (a, b) => b.score - a.score || (a.e.mtime < b.e.mtime ? 1 : a.e.mtime > b.e.mtime ? -1 : 0)
      );
      if (hits.length > SEARCH_MAX_RESULTS) truncated = true;
      const all: SearchResult[] = hits.slice(0, SEARCH_MAX_RESULTS).map((h) => ({
        name: baseName(h.path),
        path: h.path,
        textMatches: [h.snippet],
        provenance: h.e.prov ?? "user",
      }));
      const offset = (opts.page - 1) * opts.limit;
      return {
        results: all.slice(offset, offset + opts.limit),
        totalCount: all.length,
        method: "kv_index",
        ...(truncated ? { truncated } : {}),
      };
    },

    async recent(limit, opts) {
      if (opts?.folder) validateVaultPath(opts.folder);
      let sinceIso: string | undefined;
      if (opts?.since) {
        const raw = opts.since.includes("T") ? opts.since : `${opts.since}T00:00:00Z`;
        const ms = Date.parse(raw);
        if (Number.isNaN(ms)) throw new Error(`Invalid 'since' date: ${opts.since}`);
        sinceIso = new Date(ms).toISOString();
      }
      const index = await readIndex(getKv());
      return sortedEntries(index, normalizeFolder(opts?.folder))
        .filter(([p, e]) => isNotePath(p) && (!sinceIso || e.mtime >= sinceIso))
        .slice(0, limit)
        .map(([path, e]) => ({
          path,
          message: e.msg ?? DEFAULT_MESSAGE,
          date: e.mtime,
          author: PRODUCT.name,
        }));
    },

    async stats(folder?: string) {
      if (folder) validateVaultPath(folder);
      const index = await readIndex(getKv());
      const f = normalizeFolder(folder);
      const stats = computeStats(
        Object.entries(index.notes)
          .filter(([p]) => isUnderFolder(p, f))
          .map(([path, e]) => ({ path: statsPath(path), size: e.size }))
      );
      const warning = sizeWarning(index);
      return warning ? { ...stats, warning } : stats;
    },

    async health() {
      const kv = getKv();
      const healed = await heal(kv, await loadIndex(kv));
      lastHealAt = Date.now();
      const index = healed.index;
      const repaired = healed.added + healed.removed > 0;
      const notes = Object.keys(index.notes).length;
      const total = totalBytes(index);
      const warning = sizeWarning(index);
      return {
        ok: true,
        backend: "kv",
        message:
          `KV vault: ${notes} note${notes === 1 ? "" : "s"}, ${Math.round(total / 1024)} KB` +
          (repaired ? " (index repaired)" : "") +
          (warning ? ` — ${warning}` : ""),
        details: {
          notes,
          totalBytes: total,
          storage: kv.kind,
          indexRepaired: repaired,
          limits: KV_VAULT_LIMITS,
        },
      };
    },

    async linkCandidates(path: string) {
      const noteName = baseName(path).replace(/\.md$/, "");
      const pathNoExt = path.replace(/\.md$/, "");
      const index = await readIndex(getKv());
      return Object.entries(index.notes)
        .filter(
          ([p, e]) => p !== path && (e.links.includes(noteName) || e.links.includes(pathNoExt))
        )
        .map(([p]) => p)
        .sort();
    },

    async dueCandidates(folder?: string) {
      if (folder) validateVaultPath(folder);
      const f = normalizeFolder(folder);
      const index = await readIndex(getKv());
      return Object.entries(index.notes)
        .filter(([p, e]) => e.due && p.endsWith(".md") && isUnderFolder(p, f))
        .map(([p]) => p)
        .sort();
    },

    async rebuildIndex() {
      const kv = getKv();
      const index = await withLock(() => rebuild(kv));
      return { notes: Object.keys(index.notes).length, totalBytes: totalBytes(index) };
    },

    async verifyIndex() {
      const kv = getKv();
      const healed = await heal(kv, await loadIndex(kv));
      lastHealAt = Date.now();
      return { added: healed.added, removed: healed.removed };
    },

    async versions() {
      const index = await readIndex(getKv());
      const out: Record<string, string> = {};
      for (const [p, e] of Object.entries(index.notes)) out[p] = e.sha;
      return out;
    },

    async importNotes(notes, message, opts) {
      const kv = getKv();
      return withLock(async () => {
        const result: ImportNotesResult = {
          written: [],
          overwritten: [],
          kept: [],
          unchanged: [],
          rejected: [],
        };
        const valid: ImportedNote[] = [];
        for (const n of notes) {
          try {
            validateKvWritePath(n.path);
          } catch (err) {
            result.rejected.push({ path: n.path, reason: toMsg(err) });
            continue;
          }
          if (Buffer.byteLength(n.content, "utf8") > KV_VAULT_LIMITS.maxNoteBytes) {
            result.rejected.push({ path: n.path, reason: "too_large" });
            continue;
          }
          valid.push(n);
        }
        // The note keys are the truth for "does it exist" (the index may lag).
        const stored = await getMany(
          kv,
          valid.map((n) => noteKey(n.path))
        );
        const index = await loadIndexLocked(kv);
        let count = Object.keys(index.notes).length;
        const entries: Record<string, IndexEntry> = {};
        const mtime = nextMtime();
        for (let i = 0; i < valid.length; i++) {
          const n = valid[i]!;
          const existing = parseNote(stored[i] ?? null);
          if (existing) {
            if (existing.content === n.content) {
              result.unchanged.push(n.path);
              if (!index.notes[n.path]) entries[n.path] = entryFor(n.path, existing);
              continue;
            }
            if (!opts?.overwrite) {
              result.kept.push(n.path);
              continue;
            }
          } else if (count >= KV_VAULT_LIMITS.maxNotes) {
            result.rejected.push({ path: n.path, reason: "note_limit" });
            continue;
          } else {
            count++;
          }
          const note: StoredNote = {
            content: n.content,
            mtime,
            size: Buffer.byteLength(n.content, "utf8"),
            message: cleanMessage(message),
          };
          await kv.set(noteKey(n.path), JSON.stringify(note));
          entries[n.path] = entryFor(n.path, note);
          (existing ? result.overwritten : result.written).push(n.path);
        }
        if (Object.keys(entries).length > 0) {
          await commitIndex(kv, (idx) => Object.assign(idx.notes, entries), index);
        }
        return result;
      });
    },
  };
  return backend;
}

/** The KV backend bound to the current request's tenant KV store. */
export const kvVaultBackend: KvVaultBackend = createKvVaultBackend();
