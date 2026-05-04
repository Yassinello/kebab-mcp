import { NextResponse } from "next/server";
import { listCustomTools, createCustomTool } from "@/connectors/custom-tools/store";
import { customToolWriteSchema } from "@/connectors/custom-tools/types";
import { getEnabledPacksLazy } from "@/core/registry";
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

  // Reject collisions with any tool already exposed by another connector.
  // We check ALL enabled connectors except `custom-tools` itself — duplicate
  // ids inside the store are caught by createCustomTool().
  for (const p of await getEnabledPacksLazy()) {
    if (p.manifest.id === "custom-tools") continue;
    if (p.manifest.tools.some((t) => t.name === parsed.data.id)) {
      return NextResponse.json(
        {
          ok: false,
          error: `Tool name "${parsed.data.id}" is already registered by connector "${p.manifest.id}". Pick a different id.`,
        },
        { status: 409 }
      );
    }
  }

  try {
    const tool = await createCustomTool(parsed.data);
    emit("env.changed");
    return NextResponse.json({ ok: true, tool }, { status: 201 });
  } catch (err) {
    const msg = toMsg(err);
    // Duplicate id inside the Custom Tools store → 409; everything else → 500.
    const status = /already exists/i.test(msg) ? 409 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}

export const GET = withAdminAuth(getHandler);
export const POST = withAdminAuth(postHandler);
