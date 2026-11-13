/**
 * TRU-04 — POST /api/approvals/<id>: record the user's decision on a pending
 * outgoing action (approve = unlock it once, reject = delete it).
 *
 * Admin auth + Origin CSRF check via `withAdminAuth`. The body must also
 * carry the link signature: the decision is bound to the exact preview id
 * and tenant the server signed, so a guessed or swapped id is refused even
 * for an authenticated admin.
 */
import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { decide, isApprovalId, verifyApprovalSignature } from "@/core/approvals";
import { runWithTenant } from "@/core/request-context";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function postHandler(ctx: PipelineContext): Promise<Response> {
  const { id } = await (ctx.routeParams as RouteContext).params;
  if (!isApprovalId(id)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  let body: { decision?: unknown; sig?: unknown; tenant?: unknown };
  try {
    body = (await ctx.request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ ok: false, error: "invalid_decision" }, { status: 400 });
  }
  const tenant = typeof body.tenant === "string" && body.tenant ? body.tenant : null;
  const sig = typeof body.sig === "string" ? body.sig : null;
  if (!(await verifyApprovalSignature(id, tenant, sig))) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 403 });
  }

  const result = await (tenant
    ? runWithTenant(tenant, () => decide(id, decision))
    : decide(id, decision));
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.reason },
      { status: result.reason === "not_found" ? 404 : 409 }
    );
  }
  return NextResponse.json({
    ok: true,
    status: decision === "approve" ? "approved" : "rejected",
  });
}

export const POST = withAdminAuth(postHandler);
