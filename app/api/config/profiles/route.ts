import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import {
  DEFAULT_PROFILE,
  ProfileError,
  deleteProfile,
  getProfileContent,
  listProfiles,
  normalizeProfileName,
  saveProfile,
} from "@/core/profiles";
import { toMsg } from "@/core/error-utils";

/**
 * Kebab House phase 0 (CTX-03/06) — named profiles ("hats").
 *
 * GET    /api/config/profiles              → { profiles: ProfileSummary[] }
 * GET    /api/config/profiles?name=<name>  → { name, content }
 * PUT    /api/config/profiles  {name, content} → create / replace
 * DELETE /api/config/profiles?name=<name>  → delete (not `default`)
 *
 * The `default` profile stays editable through /api/config/context (inline
 * or vault mode); writing it here switches it to inline mode.
 */

function errorStatus(err: ProfileError): number {
  if (err.code === "too_large") return 413;
  if (err.code === "not_found") return 404;
  return 400;
}

async function getHandler(ctx: PipelineContext): Promise<Response> {
  const name = new URL(ctx.request.url).searchParams.get("name");
  if (name) {
    const content = await getProfileContent(name);
    if (content === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ name: normalizeProfileName(name), content });
  }
  return NextResponse.json({ profiles: await listProfiles() });
}

async function putHandler(ctx: PipelineContext): Promise<Response> {
  let body: { name?: unknown; content?: unknown };
  try {
    body = (await ctx.request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.name !== "string" || typeof body.content !== "string") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    await saveProfile(body.name, body.content);
    return NextResponse.json({ ok: true, name: normalizeProfileName(body.name) });
  } catch (err) {
    if (err instanceof ProfileError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: errorStatus(err) }
      );
    }
    return NextResponse.json({ error: "save_failed", message: toMsg(err) }, { status: 500 });
  }
}

async function deleteHandler(ctx: PipelineContext): Promise<Response> {
  const name = new URL(ctx.request.url).searchParams.get("name");
  if (!name) return NextResponse.json({ error: "missing_name" }, { status: 400 });
  if (normalizeProfileName(name) === DEFAULT_PROFILE) {
    return NextResponse.json({ error: "reserved" }, { status: 400 });
  }
  try {
    await deleteProfile(name);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ProfileError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: errorStatus(err) }
      );
    }
    return NextResponse.json({ error: "delete_failed", message: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
export const PUT = withAdminAuth(putHandler);
export const DELETE = withAdminAuth(deleteHandler);
