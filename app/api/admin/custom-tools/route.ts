import { NextResponse } from "next/server";
import { listCustomTools, createCustomTool } from "@/connectors/custom-tools/store";
import { customToolWriteSchema } from "@/connectors/custom-tools/types";
import { resolveRegistryAsync, ALL_CONNECTOR_LOADERS } from "@/core/registry";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { emit } from "@/core/events";
import { toMsg } from "@/core/error-utils";

/**
 * Custom Tools admin API — list + create.
 *
 * GET  /api/admin/custom-tools         → { ok, tools }
 * POST /api/admin/custom-tools         → { ok, tool } | { ok: false, … }
 *
 * Both require admin auth (handled by withAdminAuth → composeRequestPipeline).
 *
 * On create, we reject:
 *  - invalid Zod payloads (400, with `issues` for the dashboard form)
 *  - id collisions across the entire enabled tool surface (409) — a
 *    Custom Tool registered under the same name as a Vault / Slack / …
 *    tool would silently shadow the underlying tool, which is exactly
 *    the footgun this feature should NOT introduce.
 *  - duplicate ids inside the Custom Tools store itself (409, surfaced
 *    by the store with a clear message)
 *
 * After a successful write we emit `env.changed` so the registry cache
 * busts on the next read — newly-created tools appear in the MCP
 * surface without a process restart.
 */

async function getHandler() {
  try {
    const tools = await listCustomTools();
    return NextResponse.json({ ok: true, tools });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

async function postHandler(ctx: PipelineContext) {
  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = customToolWriteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  // CR-03 — Reject collisions with any tool registered by another
  // connector, including connectors that are *currently disabled*.
  // Otherwise an author could create a Custom Tool named e.g.
  // `slack_send_message` while Slack is disabled, then the day Slack is
  // enabled either (a) the registry exposes two tools with the same
  // name (silent shadowing — Custom Tool wins because it appears later
  // in the loader order) or (b) the colliding name simply leaks into the
  // surface. We force-load every manifest to enumerate the full tool
  // surface, not only the gated subset.
  const allCollisions = new Set<string>();
  // Start from `resolveRegistryAsync()` to leverage the cache when it's
  // warm — it returns enabled packs with full manifests, disabled with
  // stub manifests (empty tools array). For disabled stubs we then load
  // the real manifest to read its tools[].
  const states = await resolveRegistryAsync();
  for (const s of states) {
    if (s.manifest.id === "custom-tools") continue;
    if (s.enabled) {
      for (const t of s.manifest.tools) allCollisions.add(t.name);
      continue;
    }
    // Disabled — stub manifest has no tools; force-load to inspect.
    const entry = ALL_CONNECTOR_LOADERS.find((e) => e.id === s.manifest.id);
    if (!entry) continue;
    try {
      const loaded = await entry.loader();
      for (const t of loaded.tools) allCollisions.add(t.name);
    } catch {
      // Loader failure is non-fatal for the collision check — we'd
      // rather over-allow than block writes on an unrelated import error.
    }
  }
  if (allCollisions.has(parsed.data.id)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Tool name "${parsed.data.id}" is already registered by another connector (enabled or disabled). Pick a different id.`,
      },
      { status: 409 }
    );
  }

  try {
    const tool = await createCustomTool(parsed.data);
    emit("env.changed");
    return NextResponse.json({ ok: true, tool }, { status: 201 });
  } catch (err) {
    const msg = toMsg(err);
    // Duplicate id inside the Custom Tools store → 409;
    // template / toolName validation failures → 400 (author error);
    // everything else → 500.
    let status: number;
    if (/already exists/i.test(msg)) status = 409;
    else if (/template invalid|does not exist or is not callable/i.test(msg)) status = 400;
    else status = 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}

export const GET = withAdminAuth(getHandler);
export const POST = withAdminAuth(postHandler);
