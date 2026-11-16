/**
 * Kebab House phase 2 (EXP-01) — one zip with everything that is yours:
 * profiles, skills (Agent Skills folders), memory vault (Markdown), and a
 * filtered copy of the KV store. Readable without Kebab House: open the
 * vault folder in Obsidian, drop the skills in ~/.claude/skills.
 *
 * Never included: connector credentials and other secrets (SEC-02 list),
 * OAuth clients/codes/tokens, device entries, first-run claims, rate-limit
 * buckets, usage counters, and the vault/skill payloads already exported as
 * files. API connections travel without their keys (see `redactConnections`).
 *
 * 2026-11 audit (B1) — the round trip export → import must not lose or
 * clobber anything:
 *   - a default profile kept in the vault is exported with its content (it
 *     was an empty profiles/default.md, and re-importing it switched the
 *     profile to an empty inline one);
 *   - the import is additive for profiles and settings too: an existing,
 *     non-empty profile or an existing setting is never replaced unless asked
 *     (`overwriteProfiles`, `overwriteSettings`), and the report lists what
 *     was imported, overwritten and skipped;
 *   - every note is exported, `.md` or not; a note without extension is
 *     re-imported as `<path>.md`;
 *   - a safe allow-list of settings is re-imported from kebab-house.json
 *     (custom tools, API connections without keys, tool toggles, display
 *     name / timezone / locale) — never secrets;
 *   - zip bombs are refused before inflating (entry count and declared
 *     size), and inflating stops at the size cap whatever the zip declares.
 */

import { Unzip, UnzipInflate, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { exportBackup, isSecretKey } from "./backup";
import {
  listProfiles,
  getProfileContent,
  getDefaultProfileMode,
  saveProfile,
  DEFAULT_PROFILE,
} from "./profiles";
import { getInstanceConfigAsync } from "./config";
import { getContextKVStore } from "./request-context";
import { bumpConfigRevision } from "./config-revision";
import { emit } from "./events";
import { listSkills, getSkillFiles } from "@/connectors/skills/store";
import { skillMdFor } from "@/connectors/skills/lib/library";
import { toAgentName } from "@/connectors/skills/lib/bundle";
import { getVaultBackend } from "@/connectors/vault/lib/select";
import type { KvVaultBackend } from "@/connectors/vault/lib/kv-backend";
import { isNotePath, withMarkdownExtension } from "@/connectors/vault/lib/paths";
import { VaultNotFoundError } from "./connector-errors";
import { toMsg } from "./error-utils";

/** Key prefixes left out of kebab-house.json (tenant-relative). */
const EXCLUDED_PREFIXES = [
  "oauth:",
  "devices:",
  "ratelimit:",
  "usage:",
  "vault:note:",
  "vault:index",
  "skill:",
  "approvals:",
  "approval:",
  "onboarding:",
  "global:update-check",
];

function relativeKey(key: string): string {
  const m = /^tenant:[^:]+:(.*)$/.exec(key);
  return m?.[1] ?? key;
}

export function isExcludedFromExport(key: string): boolean {
  if (isSecretKey(key)) return true;
  const k = relativeKey(key);
  return EXCLUDED_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Settings re-imported from kebab-house.json (tenant-relative keys). Never a
 * secret: `isExcludedFromExport` is checked first, and API connections (a
 * secret key) only travel as the redacted `apiConnections` list.
 */
const IMPORTABLE_KEYS = new Set([
  "settings:displayName",
  "settings:timezone",
  "settings:locale",
  "custom-tools:all",
  "api:tools",
]);
const IMPORTABLE_PREFIXES = ["tool:disabled:", "customtool:versions:"];
/** Values that must be a JSON array (the stores refuse to load anything else). */
const JSON_ARRAY_KEYS = new Set(["custom-tools:all", "api:tools"]);

export function isImportableSetting(key: string): boolean {
  if (isExcludedFromExport(key)) return false;
  const k = relativeKey(key);
  return IMPORTABLE_KEYS.has(k) || IMPORTABLE_PREFIXES.some((p) => k.startsWith(p));
}

export interface FullExportReport {
  profiles: number;
  skills: number;
  notes: number;
  kvKeys: number;
  warnings: string[];
}

const README = `Kebab House export
===================

- profiles/   your profiles (Markdown), one file per hat; default.md is the default one
- skills/     your skills in the Agent Skills format (folder per skill: SKILL.md + files)
              → copy them into ~/.claude/skills, or import the folders from the dashboard
- vault/      your memory vault (Markdown) → open it as an Obsidian vault
- kebab-house.json  other settings stored in the KV (secrets, tokens and devices are excluded;
              API connections are listed without their keys)

Re-import into another Kebab House (or the same one): send this zip to the
instance's import (POST /api/config/export with the admin key). It adds
profiles, skills, notes and settings (custom tools, API connections, tool
on/off switches, display name, timezone, locale). Nothing that already exists
is replaced unless you ask (overwriteProfiles=1, overwriteNotes=1,
overwriteSettings=1). API connections come back without their keys: add them
again in the dashboard.
`;

// ── API connections without their keys ──────────────────────────────

/** Header names safe to carry over; any other header may hold a key. */
function isSafeHeader(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "accept" ||
    n === "accept-language" ||
    n === "content-type" ||
    n === "user-agent" ||
    n.endsWith("-version")
  );
}

function stripUrlSecrets(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, raw.endsWith("/") ? "/" : "");
  } catch {
    return raw;
  }
}

interface RedactedConnection {
  id: string;
  name: string;
  baseUrl: string;
  auth: { type: "none" };
  headers: Record<string, string>;
  timeoutMs?: number;
  createdAt?: string;
  updatedAt?: string;
  /** The auth type the connection had (its key is not exported). */
  authRemoved?: string;
  /** Headers left out (they may carry a key). */
  headersRemoved?: string[];
}

/** API connections with auth, credentials in the URL and non-standard headers removed. */
export function redactConnections(raw: string | null): RedactedConnection[] {
  if (!raw) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out: RedactedConnection[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.baseUrl !== "string") {
      continue;
    }
    const headers: Record<string, string> = {};
    const headersRemoved: string[] = [];
    if (r.headers && typeof r.headers === "object") {
      for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
        if (typeof v === "string" && isSafeHeader(k)) headers[k] = v;
        else headersRemoved.push(k);
      }
    }
    const authType =
      r.auth && typeof r.auth === "object" ? (r.auth as { type?: unknown }).type : undefined;
    out.push({
      id: r.id,
      name: r.name,
      baseUrl: stripUrlSecrets(r.baseUrl),
      auth: { type: "none" },
      headers,
      ...(typeof r.timeoutMs === "number" ? { timeoutMs: r.timeoutMs } : {}),
      ...(typeof r.createdAt === "string" ? { createdAt: r.createdAt } : {}),
      ...(typeof r.updatedAt === "string" ? { updatedAt: r.updatedAt } : {}),
      ...(typeof authType === "string" && authType !== "none" ? { authRemoved: authType } : {}),
      ...(headersRemoved.length ? { headersRemoved } : {}),
    });
  }
  return out;
}

// ── Export ───────────────────────────────────────────────────────────

/** Path of the default profile in the vault (vault mode). */
async function defaultProfileVaultPath(): Promise<string> {
  const cfg = await getInstanceConfigAsync();
  return cfg.contextPath || "System/context.md";
}

export async function buildFullExport(): Promise<{ zip: Uint8Array; report: FullExportReport }> {
  const files: Zippable = {};
  const warnings: string[] = [];
  const enc = (s: string) => strToU8(s);

  // Profiles
  const profiles = await listProfiles();
  for (const p of profiles) {
    let content = (await getProfileContent(p.name)) ?? "";
    if (p.name === DEFAULT_PROFILE && p.mode === "vault") {
      // The default profile lives in the vault: export its content, not the
      // (usually empty) inline value.
      const path = await defaultProfileVaultPath();
      try {
        content = (await getVaultBackend().read(path)).content;
      } catch (err) {
        warnings.push(
          `profiles/default.md: could not read ${path} from the vault (${toMsg(err)}).`
        );
      }
    }
    files[`profiles/${p.name}.md`] = enc(content);
  }

  // Skills
  const skills = await listSkills();
  for (const s of skills) {
    const dir = `skills/${toAgentName(s.id)}`;
    files[`${dir}/SKILL.md`] = enc(skillMdFor(s));
    const extra = await getSkillFiles(s.id);
    for (const [path, body] of Object.entries(extra)) files[`${dir}/${path}`] = enc(body);
  }

  // Vault: every note. On the KV backend every key is a note (text) and the
  // index is checked against the note keys first, so a note missing from the
  // index is still exported. On GitHub, Markdown files and files without an
  // extension (images and other binaries stay in the repository).
  let notes = 0;
  try {
    const vault = getVaultBackend();
    if (vault.kind === "kv") {
      const repaired = await (vault as KvVaultBackend).verifyIndex();
      if (repaired.added + repaired.removed > 0) {
        warnings.push(
          `Memory vault index repaired before export (${repaired.added} added, ${repaired.removed} removed).`
        );
      }
    }
    const tree = await vault.tree();
    for (const f of tree) {
      if (vault.kind !== "kv" && !isNotePath(f.path)) continue;
      try {
        const note = await vault.read(f.path);
        files[`vault/${f.path}`] = enc(note.content);
        notes++;
      } catch (err) {
        warnings.push(`vault/${f.path}: ${toMsg(err)}`);
      }
    }
  } catch (err) {
    warnings.push(`Memory vault not exported: ${toMsg(err)}`);
  }

  // Filtered KV
  const backup = await exportBackup();
  const entries: Record<string, string> = {};
  for (const [k, v] of Object.entries(backup.entries)) {
    if (!isExcludedFromExport(k)) entries[k] = v;
  }
  const apiConnections = redactConnections(await getContextKVStore().get("api:connections"));
  files["kebab-house.json"] = enc(
    JSON.stringify(
      {
        version: 2,
        exportedAt: backup.exportedAt,
        scope: backup.scope,
        entries,
        ...(apiConnections.length ? { apiConnections } : {}),
      },
      null,
      2
    )
  );
  files["README.txt"] = enc(README);

  return {
    zip: zipSync(files, { level: 6 }),
    report: {
      profiles: profiles.length,
      skills: skills.length,
      notes,
      kvKeys: Object.keys(entries).length,
      warnings,
    },
  };
}

// ── Safe unzip ───────────────────────────────────────────────────────

/** Largest zip accepted (compressed). */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
/** Largest total once inflated. */
export const MAX_IMPORT_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
/** Most entries in one zip (5 000 notes + skills + profiles, with room). */
export const MAX_IMPORT_ENTRIES = 10_000;

export class ImportRejectedError extends Error {
  constructor(
    message: string,
    readonly code: "too_large" | "invalid_zip"
  ) {
    super(message);
    this.name = "ImportRejectedError";
  }
}

function tooLargeError(maxBytes: number): ImportRejectedError {
  return new ImportRejectedError(
    `This zip expands to more than ${Math.round(maxBytes / 1024 / 1024)} MB. ` +
      `Import refused: it is not a Kebab House export, or it is too large to import at once.`,
    "too_large"
  );
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Unzip with hard caps. First the central directory is read without
 * inflating anything (entry count, declared sizes); then the entries are
 * inflated in a stream that counts the real bytes and stops at the cap, so a
 * zip lying about its sizes cannot get past it either.
 */
export function safeUnzip(
  zip: Uint8Array,
  limits: { maxEntries?: number; maxBytes?: number } = {}
): Record<string, Uint8Array> {
  const maxEntries = limits.maxEntries ?? MAX_IMPORT_ENTRIES;
  const maxBytes = limits.maxBytes ?? MAX_IMPORT_UNCOMPRESSED_BYTES;

  let entries = 0;
  let declared = 0;
  try {
    unzipSync(zip, {
      filter: (f) => {
        entries++;
        declared += f.originalSize;
        if (entries > maxEntries) {
          throw new ImportRejectedError(
            `This zip holds more than ${maxEntries} files. Import refused.`,
            "too_large"
          );
        }
        if (declared > maxBytes) throw tooLargeError(maxBytes);
        return false;
      },
    });
  } catch (err) {
    if (err instanceof ImportRejectedError) throw err;
    throw new ImportRejectedError(`Not a readable zip file (${toMsg(err)}).`, "invalid_zip");
  }

  const out: Record<string, Uint8Array> = {};
  let total = 0;
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, data, final) => {
      if (failure) return;
      if (err) {
        failure = new ImportRejectedError(
          `Not a readable zip file (${toMsg(err)}).`,
          "invalid_zip"
        );
        return;
      }
      size += data.length;
      total += data.length;
      if (total > maxBytes) {
        failure = tooLargeError(maxBytes);
        file.terminate();
        return;
      }
      chunks.push(data);
      if (final) out[file.name] = concat(chunks, size);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(zip, true);
  } catch (err) {
    failure ??= new ImportRejectedError(`Not a readable zip file (${toMsg(err)}).`, "invalid_zip");
  }
  if (failure) throw failure;
  return out;
}

// ── EXP-03: re-import an export zip ──────────────────────────────────

export interface FullImportReport {
  profiles: {
    imported: string[];
    overwritten: string[];
    skipped: Array<{ name: string; reason: string }>;
  };
  skills: { created: number; updated: number; failed: number };
  notes: {
    written: number;
    overwritten: number;
    skipped: number;
    failed: number;
    /** Notes without extension, imported as `<path>.md`. */
    renamed: number;
  };
  settings: {
    imported: string[];
    overwritten: string[];
    skipped: Array<{ key: string; reason: string }>;
  };
  warnings: string[];
}

export interface FullImportOptions {
  /** Replace notes that already exist. */
  overwriteNotes?: boolean | undefined;
  /** Replace profiles that already have content. */
  overwriteProfiles?: boolean | undefined;
  /** Replace settings that already exist. */
  overwriteSettings?: boolean | undefined;
}

/**
 * Import profiles, skills, vault notes and a safe allow-list of settings
 * from a Kebab House export zip. Additive: nothing is deleted, and nothing
 * that already exists is replaced unless the matching `overwrite*` option is
 * set — except skills, which get a new version (their history keeps the old
 * one).
 */
export async function importFullExport(
  zip: Uint8Array,
  opts: FullImportOptions = {}
): Promise<FullImportReport> {
  if (zip.byteLength > MAX_IMPORT_BYTES) {
    throw new ImportRejectedError(
      `Export too large (max ${MAX_IMPORT_BYTES / 1024 / 1024} MB). Import refused.`,
      "too_large"
    );
  }
  const { strFromU8 } = await import("fflate");
  const { planImport, applyImport } = await import("@/connectors/skills/lib/importer");
  const files = safeUnzip(zip);
  const report: FullImportReport = {
    profiles: { imported: [], overwritten: [], skipped: [] },
    skills: { created: 0, updated: 0, failed: 0 },
    notes: { written: 0, overwritten: 0, skipped: 0, failed: 0, renamed: 0 },
    settings: { imported: [], overwritten: [], skipped: [] },
    warnings: [],
  };
  const vault = getVaultBackend();
  /** Vault paths already written by the profile step. */
  const handled = new Set<string>();

  // Profiles
  for (const [path, body] of Object.entries(files)) {
    const m = /^profiles\/([a-z0-9][a-z0-9-]{0,39})\.md$/.exec(path);
    if (!m) continue;
    const name = m[1]!;
    const content = strFromU8(body);
    try {
      if (!content.trim()) {
        report.profiles.skipped.push({ name, reason: "empty in the export" });
        continue;
      }
      if (name === DEFAULT_PROFILE && (await getDefaultProfileMode()) === "vault") {
        // The default profile lives in the vault here: write the vault file,
        // never switch the profile to inline mode.
        const vaultPath = await defaultProfileVaultPath();
        let current: { content: string; sha: string } | null = null;
        try {
          current = await vault.read(vaultPath);
        } catch (err) {
          if (!(err instanceof VaultNotFoundError)) throw err;
        }
        handled.add(vaultPath);
        if (current?.content === content) {
          report.profiles.skipped.push({ name, reason: "unchanged" });
          continue;
        }
        if (current?.content.trim() && !opts.overwriteProfiles) {
          report.profiles.skipped.push({ name, reason: "already exists" });
          continue;
        }
        await vault.write(vaultPath, content, {
          message: "Import Kebab House export (profile)",
          ...(current ? { expectedVersion: current.sha } : {}),
        });
        (current?.content.trim() ? report.profiles.overwritten : report.profiles.imported).push(
          name
        );
        continue;
      }
      const existing = await getProfileContent(name);
      if (existing === content) {
        report.profiles.skipped.push({ name, reason: "unchanged" });
        continue;
      }
      if (existing?.trim() && !opts.overwriteProfiles) {
        report.profiles.skipped.push({ name, reason: "already exists" });
        continue;
      }
      await saveProfile(name, content, { by: "Import" });
      (existing?.trim() ? report.profiles.overwritten : report.profiles.imported).push(name);
    } catch (err) {
      report.profiles.skipped.push({ name, reason: toMsg(err) });
    }
  }

  // Skills: re-zip the skills/ folders and go through the regular importer.
  const skillFiles: Zippable = {};
  for (const [path, body] of Object.entries(files)) {
    if (path.startsWith("skills/") && !path.endsWith("/")) skillFiles[path.slice(7)] = body;
  }
  if (Object.keys(skillFiles).length) {
    const plan = await planImport({ zip: zipSync(skillFiles) });
    if (!plan.ok) {
      report.warnings.push(`skills: ${plan.error}`);
    } else {
      for (const r of await applyImport(plan.items)) {
        if (r.error) report.skills.failed++;
        else if (r.action === "updated") report.skills.updated++;
        else report.skills.created++;
      }
    }
  }

  // Vault notes: every file under vault/. A note saved without extension
  // comes back as `<path>.md` (the only form lists, stats and exports see).
  let existingNotes: Set<string> | null = null;
  for (const [path, body] of Object.entries(files)) {
    if (!path.startsWith("vault/") || path.endsWith("/")) continue;
    const original = path.slice(6);
    const target = withMarkdownExtension(original);
    const notePath = target.path;
    if (handled.has(notePath)) continue;
    try {
      existingNotes ??= new Set((await vault.tree()).map((f) => f.path));
      const exists = existingNotes.has(notePath);
      if (exists && !opts.overwriteNotes) {
        report.notes.skipped++;
        continue;
      }
      await vault.write(notePath, strFromU8(body), { message: "Import Kebab House export" });
      existingNotes.add(notePath);
      if (exists) report.notes.overwritten++;
      else report.notes.written++;
      if (target.added) report.notes.renamed++;
    } catch (err) {
      report.notes.failed++;
      report.warnings.push(`${path}: ${toMsg(err)}`);
    }
  }

  // Settings (allow-list) from kebab-house.json.
  const settingsFile = files["kebab-house.json"];
  if (settingsFile) {
    try {
      await importSettings(JSON.parse(strFromU8(settingsFile)) as unknown, opts, report);
    } catch (err) {
      report.warnings.push(`kebab-house.json: ${toMsg(err)}`);
    }
  }
  return report;
}

function isJsonArray(value: string): boolean {
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

/** Re-import the allow-listed settings; never replaces an existing key unless asked. */
async function importSettings(
  data: unknown,
  opts: FullImportOptions,
  report: FullImportReport
): Promise<void> {
  if (!data || typeof data !== "object") throw new Error("not a settings file");
  const d = data as { entries?: unknown; apiConnections?: unknown };
  const entries =
    d.entries && typeof d.entries === "object" ? (d.entries as Record<string, unknown>) : {};
  const kv = getContextKVStore();
  const s = report.settings;
  let changed = false;

  const put = async (key: string, value: string): Promise<"written" | "unchanged" | "kept"> => {
    const current = await kv.get(key);
    if (current === value) {
      s.skipped.push({ key, reason: "unchanged" });
      return "unchanged";
    }
    if (current !== null && !opts.overwriteSettings) {
      s.skipped.push({ key, reason: "already exists" });
      return "kept";
    }
    await kv.set(key, value);
    (current !== null ? s.overwritten : s.imported).push(key);
    changed = true;
    return "written";
  };

  // API connections and their tools travel together: tools point at
  // connection ids.
  const connections = Array.isArray(d.apiConnections) ? d.apiConnections : [];
  let apiToolsAllowed = true;
  if (connections.length) {
    const { apiConnectionSchema } = await import("@/connectors/api/store");
    const rows: unknown[] = [];
    const keyWarnings: string[] = [];
    for (const raw of connections) {
      if (!raw || typeof raw !== "object") continue;
      const { authRemoved, headersRemoved, ...rest } = raw as RedactedConnection;
      const parsed = apiConnectionSchema.safeParse({ ...rest, auth: { type: "none" } });
      if (!parsed.success) continue;
      rows.push(parsed.data);
      if (authRemoved || headersRemoved?.length) {
        keyWarnings.push(
          `API connection "${parsed.data.name}" was imported without its key: add it again in the dashboard.`
        );
      }
    }
    if (rows.length) {
      const outcome = await put("api:connections", JSON.stringify(rows));
      apiToolsAllowed = outcome !== "kept";
      if (outcome === "written") report.warnings.push(...keyWarnings);
    }
  }

  for (const [rawKey, value] of Object.entries(entries)) {
    const key = relativeKey(rawKey);
    if (!isImportableSetting(key)) continue;
    if (typeof value !== "string") {
      s.skipped.push({ key, reason: "not a text value" });
      continue;
    }
    if (JSON_ARRAY_KEYS.has(key)) {
      if (!isJsonArray(value)) {
        s.skipped.push({ key, reason: "unreadable" });
        continue;
      }
    }
    if (key === "api:tools" && connections.length && !apiToolsAllowed) {
      s.skipped.push({ key, reason: "API connections already exist here" });
      continue;
    }
    await put(key, value);
  }

  if (changed) {
    await bumpConfigRevision();
    emit("env.changed");
  }
}
