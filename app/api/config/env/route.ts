import { NextResponse } from "next/server";
import { getEnvStore, maskValue } from "@/core/env-store";
import { saveInstanceConfig, SETTINGS_ENV_KEYS } from "@/core/config";
import {
  isVercelApiConfigured,
  saveCredentialsToKV,
  resetCredentialHydration,
} from "@/core/credential-store";
import { detectStorageMode, clearStorageModeCache } from "@/core/storage-mode";
import { withAdminAuth } from "@/core/with-admin-auth";
import { errorResponse } from "@/core/error-response";
import type { PipelineContext } from "@/core/pipeline";
import { getCurrentTenantId } from "@/core/request-context";
import { toMsg } from "@/core/error-utils";

/**
 * v0.6 (A1): these four env-var-style keys are now backed by KVStore,
 * not EnvStore. When the dashboard sends them, we route them to KV and
 * skip the hot env-write API (which triggers a Vercel redeploy). Other
 * keys continue to go through EnvStore as before.
 */
const KV_BACKED_KEYS = new Set<string>(SETTINGS_ENV_KEYS);

function splitVars(vars: Record<string, string>): {
  kvVars: Record<string, string>;
  envVars: Record<string, string>;
} {
  const kvVars: Record<string, string> = {};
  const envVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (KV_BACKED_KEYS.has(k)) kvVars[k] = v;
    else envVars[k] = v;
  }
  return { kvVars, envVars };
}

async function persistKvSettings(
  kvVars: Record<string, string>,
  tenantId?: string | null
): Promise<void> {
  if (Object.keys(kvVars).length === 0) return;
  // Phase 48 / FACADE-04: per-tenant settings write-path.
  // When the admin is tenant-scoped (x-mymcp-tenant header present),
  // writes land in the tenant-scoped KV namespace. Root-scope writes
  // go to global (backwards compat).
  await saveInstanceConfig(
    {
      displayName: kvVars.MYMCP_DISPLAY_NAME,
      timezone: kvVars.MYMCP_TIMEZONE,
      locale: kvVars.MYMCP_LOCALE,
      contextPath: kvVars.MYMCP_CONTEXT_PATH,
    },
    tenantId
  );
}

/**
 * GET /api/config/env
 * Returns current env vars. Sensitive values are masked unless `?reveal=1`.
 */
async function getHandler(ctx: PipelineContext) {
  const url = new URL(ctx.request.url);
  const reveal = url.searchParams.get("reveal") === "1";

  try {
    const store = getEnvStore();
    const vars = await store.read();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) {
      out[k] = reveal ? v : maskValue(k, v);
    }
    // Overlay KV-backed settings so the dashboard always sees the
    // authoritative value regardless of whether env was the last writer.
    const { getInstanceConfigAsync } = await import("@/core/config");
    const cfg = await getInstanceConfigAsync(getCurrentTenantId());
    out.MYMCP_DISPLAY_NAME = cfg.displayName;
    out.MYMCP_TIMEZONE = cfg.timezone;
    out.MYMCP_LOCALE = cfg.locale;
    out.MYMCP_CONTEXT_PATH = cfg.contextPath;
    return NextResponse.json({ ok: true, kind: store.kind, vars: out });
  } catch (err) {
    // P1 fold-in: never leak err.message to the client — server log
    // has the full sanitized detail + errorId for correlation.
    return errorResponse(err, { status: 500, route: "config/env" });
  }
}

/**
 * PUT /api/config/env
 * Body: { vars: Record<string, string> } — batch write.
 * Or: { key, value } — single write.
 */
async function putHandler(ctx: PipelineContext) {
  const request = ctx.request;

  let body: { vars?: Record<string, string>; key?: string; value?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  let vars: Record<string, string>;
  if (body.vars && typeof body.vars === "object") {
    vars = body.vars;
  } else if (body.key && typeof body.value === "string") {
    vars = { [body.key]: body.value };
  } else {
    return NextResponse.json(
      { ok: false, error: "Provide either { vars: {...} } or { key, value }" },
      { status: 400 }
    );
  }

  // Validate keys
  for (const k of Object.keys(vars)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) {
      return NextResponse.json({ ok: false, error: `Invalid env var key: ${k}` }, { status: 400 });
    }
  }

  try {
    const { kvVars, envVars } = splitVars(vars);
    // IMPORTANT: detect storage mode BEFORE any write. Settings persistence
    // also goes through KV, so we have to check kv-degraded first and refuse
    // ALL writes — otherwise settings would land in a half-broken backend
    // while creds get rejected, leaving the user confused.
    const storageReport = await detectStorageMode();
    if (storageReport.mode === "kv-degraded") {
      return NextResponse.json(
        {
          ok: false,
          mode: storageReport.mode,
          error: `Storage temporarily unavailable: ${storageReport.error ?? "KV unreachable"}. Saves are blocked to prevent data loss. Retry once KV recovers.`,
        },
        { status: 503 }
      );
    }
    await persistKvSettings(kvVars, getCurrentTenantId());

    const kvWritten = Object.keys(kvVars).length;
    let result: { written: number; note?: string } = { written: 0 };
    // Surface a single backend identifier in the response so the connectors
    // tab can show the right "Saved to X" toast. Mirrors the old
    // detectStorageBackend() return values for backward compat.
    let backend: "upstash" | "vercel-api" | "filesystem" | "none" = "none";

    if (Object.keys(envVars).length > 0) {
      if (storageReport.mode === "kv") {
        // KV available — instant save, no redeploy.
        await saveCredentialsToKV(envVars);
        resetCredentialHydration();
        backend = "upstash";
        result = { written: Object.keys(envVars).length, note: "Saved to Upstash KV." };
      } else if (storageReport.mode === "static") {
        // No FS, no KV. Last-resort fallback: if VERCEL_TOKEN +
        // VERCEL_PROJECT_ID are configured, use the Vercel API to write env
        // vars (still triggers a redeploy, but at least it works). Otherwise
        // surface a clean static-mode error so the frontend can show the
        // per-connector .env stub helper.
        if (isVercelApiConfigured()) {
          const store = getEnvStore();
          result = await store.write(envVars);
          backend = "vercel-api";
        } else {
          return NextResponse.json(
            {
              ok: false,
              mode: "static",
              error:
                "This instance is in env-vars-only mode. Set credentials in your deploy environment and redeploy, or set up Upstash Redis for live saves.",
            },
            { status: 422 }
          );
        }
      } else {
        // mode === "file" — local FS (Docker, dev) or Vercel /tmp ephemeral.
        const store = getEnvStore();
        result = await store.write(envVars);
        backend = store.kind === "vercel" ? "vercel-api" : "filesystem";
      }
    }

    // Invalidate the registry cache so the next resolveRegistry() call
    // re-scans process.env and sees any newly-satisfied connectors or
    // force-disable toggles.
    const { emit } = await import("@/core/events");
    emit("env.changed");
    // Bust the storage-mode cache as well — if the user just saved
    // UPSTASH_REDIS_REST_URL/TOKEN via the dashboard, the next status fetch
    // (badge, storage tab) should reflect the new mode immediately rather
    // than waiting for the 60s TTL.
    clearStorageModeCache();
    return NextResponse.json({
      ok: true,
      storageBackend: backend,
      mode: storageReport.mode,
      // Surface `ephemeral` so the client can flip the success toast from
      // "Saved" (green) to "Saved temporarily" (amber) when the save just
      // landed on /tmp that Vercel will recycle. Without this, the toast
      // visually contradicts the ephemeral warning banner shown above.
      ephemeral: storageReport.ephemeral,
      ...result,
      written: result.written + kvWritten,
      kvWritten,
    });
  } catch (err) {
    const msg = toMsg(err);
    // Vercel filesystem races with our detection cache (e.g. cached as 'file'
    // but the FS just lost write permission). Surface a clean static-mode
    // error so the frontend renders the right helper.
    const isReadOnly = msg.includes("EROFS") || msg.includes("read-only");
    if (isReadOnly) {
      return NextResponse.json(
        {
          ok: false,
          mode: "static",
          error:
            "Filesystem became read-only mid-save. Set up Upstash Redis for live saves, or set credentials via env vars.",
        },
        { status: 422 }
      );
    }
    return errorResponse(err, { status: 500, route: "config/env" });
  }
}

export const GET = withAdminAuth(getHandler);
export const PUT = withAdminAuth(putHandler);
