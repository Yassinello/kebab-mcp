import { NextResponse } from "next/server";
import { z } from "zod";
import { getApiConnection } from "@/connectors/api/store";
import { invokeApiTool } from "@/connectors/api/lib/invoke";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

/**
 * POST /api/config/api-tools/sample
 *
 * Probe endpoint — invokes the tool's URL with real auth credentials and
 * returns the raw response for schema inference in the wizard.
 *
 * Body:
 *   {
 *     connectionId: string,
 *     toolDraft: {
 *       method: string,
 *       pathTemplate: string,
 *       arguments: Array<{name, type, required, description}>,
 *       queryTemplate?: Record<string, string>,
 *       bodyTemplate?: string,
 *       timeoutMs?: number,
 *     },
 *     testArgs?: Record<string, unknown>
 *   }
 *
 * Returns: { ok, status, body, truncated, url }
 *
 * No persistence — this is a probe only.
 */

const toolDraftSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  pathTemplate: z.string().default(""),
  arguments: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().default(""),
        required: z.boolean().default(false),
        type: z.enum(["string", "number", "boolean"]).default("string"),
      })
    )
    .default([]),
  queryTemplate: z.record(z.string(), z.string()).default({}),
  bodyTemplate: z.string().default(""),
  timeoutMs: z.number().int().min(1000).max(60000).default(30000),
});

const bodySchema = z.object({
  connectionId: z.string().min(1),
  toolDraft: toolDraftSchema,
  testArgs: z.record(z.string(), z.unknown()).default({}),
});

async function postHandler(ctx: PipelineContext) {
  let raw: unknown;
  try {
    raw = await ctx.request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { connectionId, toolDraft, testArgs } = parsed.data;

  const connection = await getApiConnection(connectionId);
  if (!connection) {
    return NextResponse.json(
      { ok: false, error: `Connection "${connectionId}" not found` },
      { status: 404 }
    );
  }

  // Build a transient ApiTool-compatible object from the draft.
  // We use a synthetic id/timestamps — invokeApiTool only reads the
  // method/path/query/body/timeout fields + connectionId.
  const now = new Date().toISOString();
  const transientTool = {
    id: "__sample__",
    connectionId,
    name: "__sample__",
    description: "",
    ...toolDraft,
    readOrWrite: "read" as const,
    destructive: false,
    outputSchema: undefined,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await invokeApiTool(connection, transientTool, testArgs);
    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      body: result.body,
      truncated: result.truncated,
      url: result.url,
    });
  } catch (err) {
    const msg = toMsg(err);
    // SSRF guard throws with "URL rejected:" prefix — surface as 400
    if (msg.includes("URL rejected")) {
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const POST = withAdminAuth(postHandler);
