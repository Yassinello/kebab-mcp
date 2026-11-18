/**
 * TRU-04 — POST /api/approvals/<id>: record the user's decision on a pending
 * outgoing action (approve = unlock it once, reject = delete it).
 *
 * Admin auth + Origin CSRF check. Audit 2026-11 (A2): only the dashboard
 * cookie session of a same-origin browser request is accepted — never an
 * Authorization header — so an AI client holding the admin key cannot
 * approve its own sends (browserSessionStep). The body must also carry the
 * link signature: the decision is bound to the exact preview id and tenant
 * the server signed, so a guessed or swapped id is refused even for an
 * authenticated admin.
 *
 * Settings changes proposed by `kebab_config` are applied right here on
 * approve (the stored change, re-validated now, once); see
 * src/core/config-proposals.ts. Every other tool's preview is only
 * unlocked, as before, and executed by the tool's next call.
 */
import { NextResponse } from "next/server";
import {
  authStep,
  browserSessionStep,
  composeRequestPipeline,
  rehydrateStep,
  type PipelineContext,
} from "@/core/pipeline";
import { decide, isApprovalId, verifyApprovalSignature } from "@/core/approvals";
import { runWithTenant } from "@/core/request-context";
import { decideConfigProposal, isConfigProposal } from "@/core/config-proposals";

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

  const run = async (): Promise<Response> => {
    if (await isConfigProposal(id)) {
      const r = await decideConfigProposal(id, decision);
      if (r.ok) return NextResponse.json({ ok: true, status: r.status, message: r.message });
      const status = r.error === "not_found" ? 404 : r.error === "apply_failed" ? 422 : 409;
      return NextResponse.json(
        { ok: false, error: r.error, ...(r.message ? { message: r.message } : {}) },
        { status }
      );
    }
    const result = await decide(id, decision);
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
  };
  return tenant ? runWithTenant(tenant, run) : run();
}

export const POST = composeRequestPipeline(
  [rehydrateStep, browserSessionStep, authStep("admin")],
  postHandler
);
