import { NextResponse } from "next/server";
import {
  listApiConnections,
  createApiConnection,
  apiConnectionCreateSchema,
} from "@/connectors/api/store";
import { isPublicUrlSync } from "@/core/url-safety";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";
import { getConfig } from "@/core/config-facade";

/**
 * Redact sensitive fields from the auth blob so GET responses don't
 * echo the stored secret back to the UI. Admin-only routes still
 * refresh the token via PATCH with a new `auth` block.
 */
function redactAuth(auth: unknown): unknown {
  if (!auth || typeof auth !== "object") return auth;
  const a = auth as { type?: string };
  switch (a.type) {
    case "bearer":
      return { type: "bearer", token: "***" };
    case "api_key_header": {
      const o = a as { headerName?: string };
      return { type: "api_key_header", headerName: o.headerName, value: "***" };
    }
    case "basic": {
      const o = a as { username?: string };
      return { type: "basic", username: o.username, password: "***" };
    }
    default:
      return auth;
  }
}

function allowLocalUrls(): boolean {
  const flag = getConfig("KEBAB_API_CONN_ALLOW_LOCAL");
  return flag === "1" || flag === "true";
}

async function getHandler() {
  try {
    const all = await listApiConnections();
    const safe = all.map((c) => ({ ...c, auth: redactAuth(c.auth) }));
    return NextResponse.json({ ok: true, connections: safe });
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

  const parsed = apiConnectionCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  // SSRF pre-flight on the configured baseUrl. We do sync (no DNS) —
  // the runtime invoke path redoes the async version at tool-call time.
  const safety = isPublicUrlSync(parsed.data.baseUrl, {
    allowLoopback: allowLocalUrls(),
    allowPrivateNetwork: allowLocalUrls(),
  });
  if (!safety.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `baseUrl rejected: ${safety.error.message}. Set KEBAB_API_CONN_ALLOW_LOCAL=1 for local/private-network URLs.`,
      },
      { status: 400 }
    );
  }

  try {
    const conn = await createApiConnection(parsed.data);
    return NextResponse.json(
      { ok: true, connection: { ...conn, auth: redactAuth(conn.auth) } },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
export const POST = withAdminAuth(postHandler);
