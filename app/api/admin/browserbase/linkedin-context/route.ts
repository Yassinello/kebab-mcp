/**
 * POST /api/admin/browserbase/linkedin-context
 *   action: "open"  → ensure context exists, persist BROWSERBASE_CONTEXT_LINKEDIN,
 *                     start a keep-alive session attached to it, return the
 *                     Browserbase Live View URL so the user can sign in to
 *                     LinkedIn manually (cookies persist via context).
 *   action: "close" → close a session by id (best-effort).
 *
 * Body shape:
 *   { action: "open" }
 *   { action: "close", sessionId: string }
 *
 * Why a dedicated route:
 *   - LinkedIn login from a datacenter IP often triggers MFA / captcha that
 *     web_act cannot solve, AND we never want passwords routed through an
 *     LLM. Live View lets the user authenticate themselves in a real browser
 *     while reusing the persistent Browserbase context.
 */
import { NextResponse } from "next/server";
import Browserbase from "@browserbasehq/sdk";
import {
  composeRequestPipeline,
  rehydrateStep,
  authStep,
  hydrateCredentialsStep,
  type PipelineContext,
} from "@/core/pipeline";
import { getConfig } from "@/core/config-facade";
import { saveCredentialsToKV, isVercelApiConfigured } from "@/core/credential-store";
import { getEnvStore } from "@/core/env-store";
import { detectStorageMode } from "@/core/storage-mode";
import { errorResponse } from "@/core/error-response";
import { toMsg } from "@/core/error-utils";
import { emit } from "@/core/events";

const CONTEXT_ENV_KEY = "BROWSERBASE_CONTEXT_LINKEDIN";

function need(key: string): { ok: true; value: string } | { ok: false; reason: string } {
  const v = getConfig(key);
  if (!v)
    return {
      ok: false,
      reason: `Missing ${key}. Save it in Connectors → Browser Automation first.`,
    };
  return { ok: true, value: v };
}

async function persistContextId(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const mode = await detectStorageMode();
  if (mode.mode === "kv-degraded") {
    return { ok: false, reason: `KV unreachable: ${mode.error ?? "unknown"} — context not saved.` };
  }
  if (mode.mode === "kv") {
    await saveCredentialsToKV({ [CONTEXT_ENV_KEY]: id });
  } else if (mode.mode === "file") {
    await getEnvStore().write({ [CONTEXT_ENV_KEY]: id });
  } else if (mode.mode === "static") {
    if (!isVercelApiConfigured()) {
      return {
        ok: false,
        reason: `Static mode without Vercel API — set ${CONTEXT_ENV_KEY}=${id} in your deploy env manually.`,
      };
    }
    await getEnvStore().write({ [CONTEXT_ENV_KEY]: id });
  }
  emit("env.changed");
  return { ok: true };
}

async function postHandler(ctx: PipelineContext): Promise<Response> {
  let body: { action?: string; sessionId?: string };
  try {
    body = await ctx.request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const apiKey = need("BROWSERBASE_API_KEY");
  const projectId = need("BROWSERBASE_PROJECT_ID");
  if (!apiKey.ok) return NextResponse.json({ ok: false, error: apiKey.reason }, { status: 400 });
  if (!projectId.ok)
    return NextResponse.json({ ok: false, error: projectId.reason }, { status: 400 });

  const bb = new Browserbase({ apiKey: apiKey.value });

  if (body.action === "close") {
    if (!body.sessionId) {
      return NextResponse.json({ ok: false, error: "sessionId required" }, { status: 400 });
    }
    try {
      // Browserbase ends a session by updating its status to REQUEST_RELEASE.
      await bb.sessions.update(body.sessionId, {
        projectId: projectId.value,
        status: "REQUEST_RELEASE",
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return errorResponse(new Error(`Failed to close session: ${toMsg(err)}`), {
        status: 502,
        route: "admin/browserbase/linkedin-context",
      });
    }
  }

  if (body.action !== "open") {
    return NextResponse.json(
      { ok: false, error: 'action must be "open" or "close"' },
      { status: 400 }
    );
  }

  try {
    let contextId = getConfig(CONTEXT_ENV_KEY) || "";
    let createdContext = false;

    let persistWarning: string | null = null;
    if (!contextId) {
      const newCtx = await bb.contexts.create({ projectId: projectId.value });
      contextId = newCtx.id;
      createdContext = true;
      const persisted = await persistContextId(contextId);
      if (!persisted.ok) persistWarning = persisted.reason;
    }

    const session = await bb.sessions.create({
      projectId: projectId.value,
      keepAlive: true,
      browserSettings: {
        context: { id: contextId, persist: true },
      },
    });

    const debug = await bb.sessions.debug(session.id);

    return NextResponse.json({
      ok: true,
      contextId,
      contextCreated: createdContext,
      persistWarning,
      sessionId: session.id,
      liveViewUrl: debug.debuggerFullscreenUrl,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    return errorResponse(new Error(`Browserbase call failed: ${toMsg(err)}`), {
      status: 502,
      route: "admin/browserbase/linkedin-context",
    });
  }
}

export const POST = composeRequestPipeline(
  [rehydrateStep, authStep("admin"), hydrateCredentialsStep],
  postHandler
);
