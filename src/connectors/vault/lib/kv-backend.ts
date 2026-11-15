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
 * Index consistency — the trade-off
 * ---------------------------------
 * Every write/delete/move updates the note key, then rewrites the index
 * (read-modify-write). The KV interface has no transactions, so two
 * instances writing at the same moment can each read the old index and the
 * second save drops the first one's entry. Kebab House is a single-owner
 * instance (one person, a few clients), so this is rare; we accept it rather
 * than add a lock service, and make the loss recoverable:
 *   - mutations are serialised inside one process (an in-process lock), so
 *     parallel tool calls landing on the same instance never race;
 *   - the index can always be rebuilt from the note keys (`rebuildIndex`):
 *     automatically when it is missing or unreadable, when a mutation finds
 *     a stored note the index does not know (drift), and when `health()`
 *     sees more or fewer note keys than index entries; manually from
 *     /config → Connectors → Memory Vault → "Rebuild index".
 * A lost index entry never loses the note itself: `vault_read` reads the
 * note key directly.
 */
import { createHash } from "node:crypto";
import { getContextKVStore } from "@/core/request-context";
import { kvScanAll, type KVStore } from "@/core/kv-store";
import { VaultConflictError, VaultLimitError, VaultNotFoundError } from "@/core/connector-errors";
import { BRAND, PRODUCT } from "@/core/constants/brand";
import { parseNoteFrontmatter, provenanceOf, type Provenance } from "./provenance";
import {
  baseName,
  isUnderFolder,
  normalizeFolder,
  validateVaultPath,
  validateVaultWritePath,
} from "./paths";
import {
  computeStats,
  type SearchResult,
  type TreeFile,
  type VaultBackend,
  type VaultFile,
  type VaultListEntry,
  type WriteOptions,
} from "./backend";

export const NOTE_PREFIX = "vault:note:";
export const INDEX_KEY = "vault:index";

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

/** Accent- and case-insensitive form used for matching. */
export function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** Position in `original` of the first occurrence of the folded `term`, or -1. */
function originalIndexOf(original: string, term: string): number {
  const folded = foldText(original);
  const idx = folded.indexOf(term);
  if (idx === -1) return -1;
  // Precomposed text folds to the same length (é → e): positions line up.
  if (folded.length === original.length) return idx;
  // Otherwise map folded positions back character by character.
  let foldedPos = 0;
  for (let i = 0; i < original.length; ) {
    const ch = String.fromCodePoint(original.codePointAt(i) ?? 0);
    const f = foldText(ch);
    if (foldedPos + f.length > idx) return i;
    foldedPos += f.length;
    i += ch.length;
  }
  return -1;
}

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

// ── In-process lock (serialises mutations on one instance) ──────────

let lockChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => undefined);
  return run;
}

// ── Backend ──────────────────────────────────────────────────────────

export interface ImportedNote {
  path: string;
  content: string;
}

export interface ImportNotesResult {
  written: string[];
  rejected: Array<{ path: string; reason: string }>;
}

export interface KvVaultBackend extends VaultBackend {
  /** Rebuild `vault:index` from the note keys. Returns the number of notes indexed. */
  rebuildIndex(): Promise<{ notes: number; totalBytes: number }>;
  /** Write many notes with a single index update (GitHub → KV import). Overwrites. */
  importNotes(notes: ImportedNote[], message: string): Promise<ImportNotesResult>;
  /** Version (blob SHA) of every indexed note — lets an import skip unchanged notes. */
  versions(): Promise<Record<string, string>>;
}

export function createKvVaultBackend(getKv: () => KVStore = getContextKVStore): KvVaultBackend {
  async function saveIndex(kv: KVStore, index: VaultIndex): Promise<void> {
    await kv.set(INDEX_KEY, JSON.stringify(index));
  }

  /** Rebuild from the note keys. Caller holds the lock (or accepts the race). */
  async function rebuild(kv: KVStore): Promise<VaultIndex> {
    const keys = (await kvScanAll(kv, `${NOTE_PREFIX}*`)).filter((k) => k.startsWith(NOTE_PREFIX));
    const index: VaultIndex = { v: 1, notes: {} };
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
        index.notes[path] = entry;
        await saveIndex(kv, index);
        const warning = sizeWarning(index);
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
            delete index.notes[path];
            await saveIndex(kv, index);
          }
          throw new VaultNotFoundError(path);
        }
        checkVersion(path, existing, opts?.expectedVersion);
        await kv.delete(noteKey(path));
        const index = await loadIndexLocked(kv);
        if (index.notes[path]) {
          delete index.notes[path];
          await saveIndex(kv, index);
        } else {
          await rebuild(kv);
        }
        return { path };
      });
    },

    async move(from: string, to: string, opts?: { message?: string | undefined }) {
      validateKvWritePath(from);
      validateKvWritePath(to);
      if (from === to) throw new Error("Source and destination are the same path");
      const kv = getKv();
      return withLock(async () => {
        const source = await readStored(kv, from);
        if (!source) throw new VaultNotFoundError(from);
        const moved: StoredNote = {
          content: source.content,
          mtime: nextMtime(),
          size: source.size,
          message: cleanMessage(opts?.message ?? `Move ${from} → ${to}`),
        };
        // Write the copy first: if the delete fails the note is duplicated,
        // never lost.
        await kv.set(noteKey(to), JSON.stringify(moved));
        await kv.delete(noteKey(from));
        const index = await loadIndexLocked(kv);
        if (!index.notes[from]) {
          // Drift: the source was not indexed — rebuild from the notes.
          await rebuild(kv);
        } else {
          delete index.notes[from];
          index.notes[to] = entryFor(to, moved);
          await saveIndex(kv, index);
        }
        return { from, to };
      });
    },

    async list(folder?: string): Promise<VaultListEntry[]> {
      if (folder) validateVaultPath(folder);
      const f = normalizeFolder(folder);
      const index = await loadIndex(getKv());
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
      const index = await loadIndex(getKv());
      return Object.entries(index.notes)
        .filter(([p]) => isUnderFolder(p, f))
        .map(([path, e]) => ({ path, size: e.size, sha: e.sha }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },

    async search(query, opts) {
      if (opts.folder) validateVaultPath(opts.folder);
      const terms = foldText(query).split(/\s+/).filter(Boolean);
      if (terms.length === 0) throw new Error("Search query is empty");
      const kv = getKv();
      const index = await loadIndex(kv);
      const candidates = sortedEntries(index, normalizeFolder(opts.folder));

      const toResult = (path: string, e: IndexEntry, match: string): SearchResult => ({
        name: baseName(path),
        path,
        textMatches: [match],
        provenance: e.prov ?? "user",
      });

      // Pass 1: titles (and file names) — answered from the index alone.
      const titleMatches: SearchResult[] = [];
      const rest: Array<[string, IndexEntry]> = [];
      let truncated = false;
      for (const [path, e] of candidates) {
        const hay = foldText(`${e.title}\n${baseName(path)}`);
        if (terms.every((t) => hay.includes(t))) {
          if (titleMatches.length < SEARCH_MAX_RESULTS) {
            titleMatches.push(toResult(path, e, `Title match: ${e.title}`));
          } else {
            truncated = true;
          }
        } else {
          rest.push([path, e]);
        }
      }

      // Pass 2: contents, most recent first, capped in notes and bytes.
      const contentMatches: SearchResult[] = [];
      let scannedNotes = 0;
      let scannedBytes = 0;
      const firstTerm = terms[0]!;
      outer: for (let i = 0; i < rest.length; i += READ_CHUNK) {
        if (titleMatches.length + contentMatches.length >= SEARCH_MAX_RESULTS) {
          truncated = true;
          break;
        }
        const chunk = rest.slice(i, i + READ_CHUNK);
        const values = await getMany(
          kv,
          chunk.map(([p]) => noteKey(p))
        );
        for (let j = 0; j < chunk.length; j++) {
          if (
            scannedNotes >= SEARCH_MAX_SCAN_NOTES ||
            scannedBytes >= SEARCH_MAX_SCAN_BYTES ||
            titleMatches.length + contentMatches.length >= SEARCH_MAX_RESULTS
          ) {
            truncated = true;
            break outer;
          }
          const [path, e] = chunk[j]!;
          const note = parseNote(values[j] ?? null);
          if (!note) continue;
          scannedNotes++;
          scannedBytes += note.size;
          const folded = foldText(note.content);
          if (!terms.every((t) => folded.includes(t))) continue;
          const idx = Math.max(0, originalIndexOf(note.content, firstTerm));
          const start = Math.max(0, idx - 50);
          const end = Math.min(note.content.length, idx + firstTerm.length + 50);
          const fragment =
            (start > 0 ? "..." : "") +
            note.content.slice(start, end).trim() +
            (end < note.content.length ? "..." : "");
          contentMatches.push(toResult(path, e, fragment));
        }
      }

      const all = [...titleMatches, ...contentMatches];
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
      const index = await loadIndex(getKv());
      return sortedEntries(index, normalizeFolder(opts?.folder))
        .filter(([p, e]) => p.endsWith(".md") && (!sinceIso || e.mtime >= sinceIso))
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
      const index = await loadIndex(getKv());
      const f = normalizeFolder(folder);
      const stats = computeStats(
        Object.entries(index.notes)
          .filter(([p]) => isUnderFolder(p, f))
          .map(([path, e]) => ({ path, size: e.size }))
      );
      const warning = sizeWarning(index);
      return warning ? { ...stats, warning } : stats;
    },

    async health() {
      const kv = getKv();
      let index = await loadIndex(kv);
      const keys = (await kvScanAll(kv, `${NOTE_PREFIX}*`)).filter((k) =>
        k.startsWith(NOTE_PREFIX)
      );
      const indexed = Object.keys(index.notes).length;
      let repaired = false;
      if (keys.length !== indexed) {
        index = await withLock(() => rebuild(kv));
        repaired = true;
      }
      const notes = Object.keys(index.notes).length;
      const total = totalBytes(index);
      const warning = sizeWarning(index);
      return {
        ok: true,
        backend: "kv",
        message:
          `KV vault: ${notes} note${notes === 1 ? "" : "s"}, ${Math.round(total / 1024)} KB` +
          (repaired ? " (index rebuilt)" : "") +
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
      const index = await loadIndex(getKv());
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
      const index = await loadIndex(getKv());
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

    async versions() {
      const index = await loadIndex(getKv());
      const out: Record<string, string> = {};
      for (const [p, e] of Object.entries(index.notes)) out[p] = e.sha;
      return out;
    },

    async importNotes(notes: ImportedNote[], message: string) {
      const kv = getKv();
      return withLock(async () => {
        const index = await loadIndexLocked(kv);
        const written: string[] = [];
        const rejected: Array<{ path: string; reason: string }> = [];
        const mtime = nextMtime();
        for (const n of notes) {
          try {
            validateKvWritePath(n.path);
          } catch (err) {
            rejected.push({ path: n.path, reason: (err as Error).message });
            continue;
          }
          const size = Buffer.byteLength(n.content, "utf8");
          if (size > KV_VAULT_LIMITS.maxNoteBytes) {
            rejected.push({ path: n.path, reason: "too_large" });
            continue;
          }
          if (!index.notes[n.path] && Object.keys(index.notes).length >= KV_VAULT_LIMITS.maxNotes) {
            rejected.push({ path: n.path, reason: "note_limit" });
            continue;
          }
          const note: StoredNote = {
            content: n.content,
            mtime,
            size,
            message: cleanMessage(message),
          };
          await kv.set(noteKey(n.path), JSON.stringify(note));
          index.notes[n.path] = entryFor(n.path, note);
          written.push(n.path);
        }
        if (written.length > 0) await saveIndex(kv, index);
        return { written, rejected };
      });
    },
  };
  return backend;
}

/** The KV backend bound to the current request's tenant KV store. */
export const kvVaultBackend: KvVaultBackend = createKvVaultBackend();
