import { NextResponse } from "next/server";
import { applyImport, planImport } from "@/connectors/skills/lib/importer";
import { MAX_ZIP_UPLOAD_BYTES } from "@/connectors/skills/lib/bundle";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";

/**
 * Skills v2 — import Agent Skills bundles (spec §7).
 *
 * POST JSON { action: "preview" | "save", skillMd?: string, zipBase64?: string }
 *   preview → { items: [{name, title, action: create|update, files, tags, warnings}] }
 *   save    → { results: [{name, id, action, error?}] }
 * Nothing is executed; content is stored as data.
 */

interface Body {
  action?: "preview" | "save";
  skillMd?: string;
  zipBase64?: string;
}

async function postHandler(ctx: PipelineContext) {
  let body: Body;
  try {
    body = (await ctx.request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  let zip: Uint8Array | undefined;
  if (typeof body.zipBase64 === "string" && body.zipBase64) {
    // base64 inflates by ~4/3 — reject before decoding.
    if (body.zipBase64.length > Math.ceil((MAX_ZIP_UPLOAD_BYTES * 4) / 3) + 4) {
      return NextResponse.json({ error: "zip_too_large" }, { status: 413 });
    }
    zip = new Uint8Array(Buffer.from(body.zipBase64, "base64"));
  }
  const plan = await planImport({
    ...(zip ? { zip } : {}),
    ...(typeof body.skillMd === "string" ? { skillMd: body.skillMd } : {}),
  });
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });

  if (body.action === "save") {
    const results = await applyImport(plan.items);
    const failed = results.filter((r) => r.error).length;
    return NextResponse.json({ results }, { status: failed === results.length ? 500 : 200 });
  }
  return NextResponse.json({
    items: plan.items.map((i) => ({
      name: i.name,
      title: i.title,
      description: i.description,
      action: i.action,
      tags: i.tags,
      files: Object.keys(i.files),
      bodyChars: i.body.length,
      warnings: i.warnings,
    })),
  });
}

export const POST = withAdminAuth(postHandler);
