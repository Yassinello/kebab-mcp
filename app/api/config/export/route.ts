import { withAdminAuth } from "@/core/with-admin-auth";
import { buildFullExport, importFullExport } from "@/core/full-export";
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

/**
 * EXP-03 — POST /api/config/export?overwriteNotes=1 with the zip as the
 * body: re-imports profiles, skills and vault notes (additive).
 */
async function postHandler(ctx: PipelineContext): Promise<Response> {
  const buf = new Uint8Array(await ctx.request.arrayBuffer());
  if (buf.byteLength === 0) {
    return Response.json({ error: "empty_body" }, { status: 400 });
  }
  const overwriteNotes = new URL(ctx.request.url).searchParams.get("overwriteNotes") === "1";
  try {
    const report = await importFullExport(buf, { overwriteNotes });
    return Response.json({ ok: true, report }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: "import_failed", message: toMsg(err) }, { status: 400 });
  }
}

export const GET = withAdminAuth(getHandler);
export const POST = withAdminAuth(postHandler);
