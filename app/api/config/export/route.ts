import { withAdminAuth } from "@/core/with-admin-auth";
import {
  buildFullExport,
  importFullExport,
  ImportRejectedError,
  MAX_IMPORT_BYTES,
} from "@/core/full-export";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

/**
 * Kebab House phase 2 (EXP-01/02) — GET /api/config/export: everything that
 * is yours in one zip (profiles, skills, memory vault, filtered settings).
 * Admin only; secrets, tokens and devices are never included.
 */
async function getHandler(): Promise<Response> {
  const { zip, report } = await buildFullExport();
  const day = new Date().toISOString().slice(0, 10);
  return new Response(Buffer.from(zip), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="kebab-house-export-${day}.zip"`,
      "Cache-Control": "no-store",
      "X-Kebab-Export": JSON.stringify({
        profiles: report.profiles,
        skills: report.skills,
        notes: report.notes,
        kvKeys: report.kvKeys,
        warnings: report.warnings.length,
      }),
    },
  });
}

const NO_STORE = { "Cache-Control": "no-store" };

function tooLarge(): Response {
  return Response.json(
    {
      error: "too_large",
      message: `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB. Import refused.`,
    },
    { status: 413, headers: NO_STORE }
  );
}

/**
 * Read the request body, refusing early (2026-11 audit, B1): a declared
 * Content-Length above the cap is rejected before reading anything, and a
 * body streamed without one stops being read as soon as it passes the cap.
 * Returns null when the body is too large.
 */
async function readCappedBody(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(await request.arrayBuffer());
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * EXP-03 — POST /api/config/export with the zip as the body: re-imports
 * profiles, skills, vault notes and a safe allow-list of settings. Additive:
 * existing items are kept unless `overwriteNotes=1`, `overwriteProfiles=1` or
 * `overwriteSettings=1`. The response lists what was imported, overwritten
 * and skipped.
 */
async function postHandler(ctx: PipelineContext): Promise<Response> {
  const buf = await readCappedBody(ctx.request, MAX_IMPORT_BYTES);
  if (buf === null) return tooLarge();
  if (buf.byteLength === 0) {
    return Response.json({ error: "empty_body" }, { status: 400 });
  }
  const params = new URL(ctx.request.url).searchParams;
  const flag = (name: string) => params.get(name) === "1";
  try {
    const report = await importFullExport(buf, {
      overwriteNotes: flag("overwriteNotes"),
      overwriteProfiles: flag("overwriteProfiles"),
      overwriteSettings: flag("overwriteSettings"),
    });
    return Response.json({ ok: true, report }, { headers: NO_STORE });
  } catch (err) {
    const tooBig = err instanceof ImportRejectedError && err.code === "too_large";
    return Response.json(
      { error: tooBig ? "too_large" : "import_failed", message: toMsg(err) },
      { status: tooBig ? 413 : 400, headers: NO_STORE }
    );
  }
}

export const GET = withAdminAuth(getHandler);
export const POST = withAdminAuth(postHandler);
