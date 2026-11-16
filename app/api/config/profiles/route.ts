import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import {
  DEFAULT_PROFILE,
  ProfileError,
  deleteProfile,
  getProfileContent,
  listProfileHistory,
  listProfiles,
  normalizeProfileName,
  restoreProfileVersion,
  saveProfile,
} from "@/core/profiles";
import { toMsg } from "@/core/error-utils";

/**
 * Kebab House phase 0 (CTX-03/06) — named profiles ("hats").
 *
 * GET    /api/config/profiles                      → { profiles: ProfileSummary[] }
 * GET    /api/config/profiles?name=<name>          → { name, content, mode, bytes, updatedAt, by? }
 * GET    /api/config/profiles?name=<name>&history=1 → { name, history: ProfileHistoryEntry[] }
 * PUT    /api/config/profiles  {name, content}     → create / replace
 * POST   /api/config/profiles  {action: "restore", name, index} → restore a saved version
 * DELETE /api/config/profiles?name=<name>          → delete (not `default`)
 *
 * The `default` profile stays editable through /api/config/context (inline
 * or vault mode); writing it here switches it to inline mode.
 *
 * Saves and restores made here are recorded as made from the dashboard.
 */

const DASHBOARD_LABEL = "Dashboard";

function errorStatus(err: ProfileError): number {
  if (err.code === "too_large") return 413;
  if (err.code === "not_found" || err.code === "no_version") return 404;
  return 400;
}

function profileErrorResponse(err: unknown, fallback: string): Response {
  if (err instanceof ProfileError) {
    return NextResponse.json(
      { error: err.code, message: err.message },
      { status: errorStatus(err) }
    );
  }
  return NextResponse.json({ error: fallback, message: toMsg(err) }, { status: 500 });
}

async function getHandler(ctx: PipelineContext): Promise<Response> {
  const params = new URL(ctx.request.url).searchParams;
  const name = params.get("name");
  if (name) {
    const n = normalizeProfileName(name);
    if (params.get("history") === "1") {
      if (n !== DEFAULT_PROFILE && (await getProfileContent(n)) === null) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return NextResponse.json(
        { name: n, history: await listProfileHistory(n) },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    const content = await getProfileContent(name);
    if (content === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const summary = (await listProfiles()).find((p) => p.name === n);
    return NextResponse.json({ ...summary, name: n, content });
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
    await saveProfile(body.name, body.content, { by: DASHBOARD_LABEL });
    return NextResponse.json({ ok: true, name: normalizeProfileName(body.name) });
  } catch (err) {
    return profileErrorResponse(err, "save_failed");
  }
}

async function postHandler(ctx: PipelineContext): Promise<Response> {
  let body: { action?: unknown; name?: unknown; index?: unknown };
  try {
    body = (await ctx.request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.action !== "restore") {
    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  }
  if (typeof body.name !== "string" || typeof body.index !== "number") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const n = normalizeProfileName(body.name);
  if (n !== DEFAULT_PROFILE && (await getProfileContent(n)) === null) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const entry = await restoreProfileVersion(n, body.index, { by: DASHBOARD_LABEL });
    return NextResponse.json({ ok: true, name: n, restored: { savedAt: entry.savedAt } });
  } catch (err) {
    return profileErrorResponse(err, "restore_failed");
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
    return profileErrorResponse(err, "delete_failed");
  }
}

export const GET = withAdminAuth(getHandler);
export const PUT = withAdminAuth(putHandler);
export const POST = withAdminAuth(postHandler);
export const DELETE = withAdminAuth(deleteHandler);
