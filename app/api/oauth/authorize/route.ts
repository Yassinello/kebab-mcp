import { NextResponse } from "next/server";
import {
  authStep,
  browserSessionStep,
  composeRequestPipeline,
  rehydrateStep,
  type PipelineContext,
} from "@/core/pipeline";
import {
  OAuthError,
  issueCode,
  newOAuthDeviceId,
  publicOrigin,
  readAuthorizeParams,
  validateAuthorize,
} from "@/core/oauth";
import { findOAuthDeviceByClientId, isAccessLevel, type AccessLevel } from "@/core/devices";
import { getCurrentTenantId } from "@/core/request-context";

interface DecisionBody {
  query?: unknown;
  decision?: unknown;
  label?: unknown;
  skillTags?: unknown;
  profile?: unknown;
  /** Audit 2026-11: "read" | "memory" | "full". */
  access?: unknown;
  /** Legacy consent form: true = "full". */
  writeAllowed?: unknown;
}

function withParams(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

function normalizeTags(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== "string") continue;
    const n = t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.length ? out.slice(0, 20) : null;
}

/** The chosen access level; a body without a valid choice fails closed to "read". */
function accessFrom(body: DecisionBody): AccessLevel {
  if (isAccessLevel(body.access)) return body.access;
  return body.writeAllowed === true ? "full" : "read";
}

/**
 * Kebab House phase 1 (OAU-06) — the owner's decision on an authorization
 * request. Returns the URL the browser must navigate to (code or
 * access_denied, with state + iss).
 *
 * Audit 2026-11: only the dashboard cookie session of a same-origin browser
 * request is accepted (browserSessionStep) — a client holding the admin key
 * cannot approve itself. The device is created (or the client's existing
 * device reused) when the code is exchanged, not here.
 */
async function postHandler(ctx: PipelineContext): Promise<Response> {
  if (getCurrentTenantId() !== null) {
    return NextResponse.json(
      { message: "OAuth is only available on the root instance." },
      { status: 403 }
    );
  }
  let body: DecisionBody;
  try {
    body = (await ctx.request.json()) as DecisionBody;
  } catch {
    return NextResponse.json({ message: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body.query !== "string") {
    return NextResponse.json({ message: "Missing authorization request" }, { status: 400 });
  }
  const origin = publicOrigin(ctx.request);
  let v;
  try {
    v = await validateAuthorize(readAuthorizeParams(new URLSearchParams(body.query)), origin);
  } catch (err) {
    const message = err instanceof OAuthError ? err.message : "Invalid authorization request";
    return NextResponse.json({ message }, { status: 400 });
  }

  if (body.decision !== "approve") {
    return NextResponse.json({
      redirect: withParams(v.redirect_uri, {
        error: "access_denied",
        error_description: "The owner denied the request",
        state: v.state,
        iss: origin,
      }),
    });
  }

  const existing = await findOAuthDeviceByClientId(v.client.client_id);
  const label =
    typeof body.label === "string" && body.label.trim() ? body.label : v.client.client_name;
  const profile =
    typeof body.profile === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(body.profile)
      ? body.profile
      : null;
  const code = await issueCode(v, existing?.id ?? newOAuthDeviceId(), {
    label,
    clientName: v.client.client_name,
    skillTags: normalizeTags(body.skillTags),
    profile,
    access: accessFrom(body),
  });
  return NextResponse.json({
    redirect: withParams(v.redirect_uri, { code, state: v.state, iss: origin }),
  });
}

export const POST = composeRequestPipeline(
  [rehydrateStep, browserSessionStep, authStep("admin")],
  postHandler
);
