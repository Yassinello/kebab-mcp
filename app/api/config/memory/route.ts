import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";
import { VaultNotFoundError } from "@/core/connector-errors";
import { getVaultBackend } from "@/connectors/vault/lib/select";
import { validateVaultPath, validateVaultWritePath } from "@/connectors/vault/lib/paths";
import { noteProvenance } from "@/connectors/vault/lib/provenance";
import type { RecentNote, VaultBackend } from "@/connectors/vault/lib/backend";

/**
 * 2026-11 audit (C1.3) — the dashboard's Memory page: browse, search, read
 * and delete the notes in the memory vault, through whichever backend
 * serves the vault (KV or GitHub). Admin only; read-only except DELETE.
 *
 * GET    /api/config/memory?view=folders              → { backend, totalNotes, totalSize, folders }
 * GET    /api/config/memory?folder=<f>&offset=&limit= → notes directly in a folder ("" = root)
 * GET    /api/config/memory?q=<query>&page=&limit=    → search results
 * GET    /api/config/memory?path=<note.md>            → one note (content, provenance, last change)
 * DELETE /api/config/memory?path=<note.md>            → delete one note
 *
 * Paths go through the vault's own validators (no `..`, no leading `/`,
 * no NUL; deletes also refuse `.git*` / `.github`). Only Markdown notes
 * (`.md`) can be read or deleted here.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_QUERY_CHARS = 200;
/** KV: one index read covers every note; this only bounds the list size. */
const KV_RECENT_SCAN = 5000;

function noStore(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? "");
  if (!raw || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function isNotFound(err: unknown): boolean {
  return err instanceof VaultNotFoundError || /not found|404/i.test(toMsg(err));
}

/** Validate a note path for reading (`write` adds the delete-time rules). Returns an error message. */
function checkNotePath(path: string, write: boolean): string | null {
  try {
    if (write) validateVaultWritePath(path);
    else validateVaultPath(path);
  } catch (err) {
    return toMsg(err);
  }
  if (!path.toLowerCase().endsWith(".md")) return "Only Markdown notes (.md) can be opened here.";
  return null;
}

function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Last change of the notes of one folder. KV: one index read (cheap). GitHub:
 * listing commits costs one API call per commit, so only single notes get a
 * date there (see noteLastChange) and listings show none.
 */
async function folderLastChanges(
  backend: VaultBackend,
  folder: string
): Promise<Map<string, RecentNote>> {
  const out = new Map<string, RecentNote>();
  if (backend.kind !== "kv") return out;
  try {
    const recent = await backend.recent(KV_RECENT_SCAN, folder ? { folder } : undefined);
    for (const r of recent) out.set(r.path, r);
  } catch {
    // silent-swallow-ok: dates are a nice-to-have on the listing
  }
  return out;
}

async function noteLastChange(backend: VaultBackend, path: string): Promise<RecentNote | null> {
  try {
    if (backend.kind === "kv") {
      return (await folderLastChanges(backend, parentFolder(path))).get(path) ?? null;
    }
    // GitHub: commits that touched this file — the first one is the latest.
    const [latest] = await backend.recent(1, { folder: path });
    return latest ?? null;
  } catch {
    return null;
  }
}

async function foldersView(backend: VaultBackend): Promise<Response> {
  const stats = await backend.stats();
  const folders = Object.entries(stats.folderCounts)
    .map(([path, count]) => ({ path: path === "(root)" ? "" : path, count }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return noStore({
    backend: backend.kind,
    totalNotes: stats.totalNotes,
    totalSize: stats.totalSize,
    folders,
    ...(stats.warning ? { warning: stats.warning } : {}),
  });
}

async function folderView(
  backend: VaultBackend,
  folder: string,
  params: URLSearchParams
): Promise<Response> {
  const f = folder.replace(/\/+$/, "");
  if (f) {
    try {
      validateVaultPath(f);
    } catch (err) {
      return noStore({ error: "invalid_path", message: toMsg(err) }, 400);
    }
  }
  const offset = intParam(params.get("offset"), 0, 0, 1_000_000);
  const limit = intParam(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const prefix = f ? `${f}/` : "";
  const files = (await backend.tree(f || undefined)).filter(
    (t) =>
      t.path.endsWith(".md") &&
      t.path.startsWith(prefix) &&
      !t.path.slice(prefix.length).includes("/")
  );
  const page = files.slice(offset, offset + limit);
  const dates = await folderLastChanges(backend, f);
  return noStore({
    backend: backend.kind,
    folder: f,
    total: files.length,
    offset,
    limit,
    notes: page.map((t) => ({
      path: t.path,
      name: t.path.slice(prefix.length),
      size: t.size,
      updatedAt: dates.get(t.path)?.date ?? null,
    })),
  });
}

async function searchView(
  backend: VaultBackend,
  query: string,
  params: URLSearchParams
): Promise<Response> {
  const q = query.trim().slice(0, MAX_QUERY_CHARS);
  if (!q) return noStore({ error: "empty_query" }, 400);
  const page = intParam(params.get("page"), 1, 1, 1000);
  const limit = intParam(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const out = await backend.search(q, { limit, page });
  return noStore({
    backend: backend.kind,
    query: q,
    page,
    limit,
    totalCount: out.totalCount,
    truncated: out.truncated === true,
    results: out.results
      .filter((r) => r.path.endsWith(".md"))
      .map((r) => ({
        path: r.path,
        name: r.name,
        snippet: (r.textMatches[0] ?? "").slice(0, 300),
        provenance: r.provenance ?? null,
      })),
  });
}

async function noteView(backend: VaultBackend, path: string): Promise<Response> {
  const bad = checkNotePath(path, false);
  if (bad) return noStore({ error: "invalid_path", message: bad }, 400);
  const file = await backend.read(path);
  const change = await noteLastChange(backend, path);
  return noStore({
    backend: backend.kind,
    path: file.path,
    name: file.name,
    size: file.size,
    version: file.sha,
    content: file.content,
    provenance: noteProvenance(file.content),
    updatedAt: change?.date ?? null,
    change: change ? { message: change.message, author: change.author } : null,
  });
}

async function getHandler(ctx: PipelineContext): Promise<Response> {
  const params = new URL(ctx.request.url).searchParams;
  const backend = getVaultBackend();
  try {
    const path = params.get("path");
    if (path !== null) return await noteView(backend, path);
    const q = params.get("q");
    if (q !== null) return await searchView(backend, q, params);
    const folder = params.get("folder");
    if (folder !== null) return await folderView(backend, folder, params);
    return await foldersView(backend);
  } catch (err) {
    if (isNotFound(err)) return noStore({ error: "not_found", message: toMsg(err) }, 404);
    return noStore({ error: "vault_error", backend: backend.kind, message: toMsg(err) }, 502);
  }
}

async function deleteHandler(ctx: PipelineContext): Promise<Response> {
  const path = new URL(ctx.request.url).searchParams.get("path");
  if (!path) return noStore({ error: "missing_path" }, 400);
  const bad = checkNotePath(path, true);
  if (bad) return noStore({ error: "invalid_path", message: bad }, 400);
  const backend = getVaultBackend();
  try {
    await backend.delete(path, { message: "Deleted from the dashboard" });
    return noStore({ ok: true, path });
  } catch (err) {
    if (isNotFound(err)) return noStore({ error: "not_found", message: toMsg(err) }, 404);
    return noStore({ error: "delete_failed", message: toMsg(err) }, 502);
  }
}

export const GET = withAdminAuth(getHandler);
export const DELETE = withAdminAuth(deleteHandler);
