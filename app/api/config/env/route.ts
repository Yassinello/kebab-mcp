import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { getEnvStore, maskValue } from "@/core/env-store";
import { saveInstanceConfig, SETTINGS_ENV_KEYS } from "@/core/config";

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

async function persistKvSettings(kvVars: Record<string, string>): Promise<void> {
  if (Object.keys(kvVars).length === 0) return;
  await saveInstanceConfig({
    displayName: kvVars.MYMCP_DISPLAY_NAME,
    timezone: kvVars.MYMCP_TIMEZONE,
    locale: kvVars.MYMCP_LOCALE,
    contextPath: kvVars.MYMCP_CONTEXT_PATH,
  });
}

/**
 * GET /api/config/env
 * Returns current env vars. Sensitive values are masked unless `?reveal=1`.
 */
export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
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
    const cfg = await getInstanceConfigAsync();
    out.MYMCP_DISPLAY_NAME = cfg.displayName;
    out.MYMCP_TIMEZONE = cfg.timezone;
    out.MYMCP_LOCALE = cfg.locale;
    out.MYMCP_CONTEXT_PATH = cfg.contextPath;
    return NextResponse.json({ ok: true, kind: store.kind, vars: out });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/config/env
 * Body: { vars: Record<string, string> } — batch write.
 * Or: { key, value } — single write.
 */
export async function PUT(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

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
    await persistKvSettings(kvVars);

    const store = getEnvStore();
    let result: { written: number; note?: string } = { written: 0 };
    if (Object.keys(envVars).length > 0) {
      result = await store.write(envVars);
    }
    const kvWritten = Object.keys(kvVars).length;
    // Invalidate the registry cache so the next resolveRegistry() call
    // re-scans process.env and sees any newly-satisfied connectors or
    // force-disable toggles.
    const { emit } = await import("@/core/events");
    emit("env.changed");
    return NextResponse.json({
      ok: true,
      kind: store.kind,
      ...result,
      written: result.written + kvWritten,
      kvWritten,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Vercel's filesystem is read-only. If the user hasn't configured
    // VERCEL_TOKEN + VERCEL_PROJECT_ID, the FilesystemEnvStore tries to
    // write .env and hits EROFS. Surface a helpful message.
    const isReadOnly = msg.includes("EROFS") || msg.includes("read-only");
    const error = isReadOnly
      ? "Cannot save — Vercel filesystem is read-only. Add VERCEL_TOKEN and VERCEL_PROJECT_ID to your Vercel project env vars, then redeploy."
      : msg;
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
