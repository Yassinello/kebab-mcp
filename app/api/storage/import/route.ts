import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { detectStorageMode } from "@/core/storage-mode";
import { saveCredentialsToKV, readAllCredentialsFromKV } from "@/core/credential-store";
import { getEnvStore, parseEnvFile } from "@/core/env-store";
import { saveInstanceConfig, SETTINGS_ENV_KEYS } from "@/core/config";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * POST /api/storage/import
 * Body: raw text/plain in .env format.
 * Query: ?dryRun=1 returns the diff without writing.
 *
 * Restores a previously-exported backup. Routes vars to the right backend
 * based on the current storage mode:
 *   - Settings keys (MYMCP_DISPLAY_NAME, etc) → KV-backed instance config
 *   - Other vars → KV (kv mode) or env store (file mode)
 *   - static / kv-degraded → 422, no writes
 *
 * Settings keys are ALWAYS allowed (they're framework config, not creds)
 * so a user importing their backup can restore display name + timezone
 * even before re-enabling KV/file storage.
 */
async function postHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be text/plain" }, { status: 400 });
  }

  if (!bodyText || bodyText.length > 1_000_000) {
    return NextResponse.json(
      { ok: false, error: "Body must be non-empty and < 1MB" },
      { status: 400 }
    );
  }

  const { vars: parsed } = parseEnvFile(bodyText);

  // Drop meta vars that aren't useful in a backup (and would clobber Vercel's
  // own injected vars on import).
  const SKIP_KEYS = new Set([
    "VERCEL",
    "VERCEL_ENV",
    "VERCEL_URL",
    "VERCEL_REGION",
    "VERCEL_GIT_COMMIT_SHA",
    "VERCEL_GIT_COMMIT_REF",
    "VERCEL_GIT_PROVIDER",
    "VERCEL_GIT_REPO_SLUG",
    "VERCEL_GIT_REPO_OWNER",
    "VERCEL_GIT_COMMIT_MESSAGE",
    "VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
    "VERCEL_GIT_COMMIT_AUTHOR_NAME",
    "VERCEL_GIT_PULL_REQUEST_ID",
    "NODE_ENV",
    "NEXT_RUNTIME",
    "__NEXT_PRIVATE_STANDALONE_CONFIG",
  ]);
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (SKIP_KEYS.has(k)) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) continue;
    if (!v) continue;
    filtered[k] = v;
  }

  if (Object.keys(filtered).length === 0) {
    return NextResponse.json(
      { ok: false, error: "No importable keys found in body" },
      { status: 400 }
    );
  }

  const report = await detectStorageMode();

  // Check existing values to compute the diff. Settings come from KV-backed
  // instance config; cred-style keys come from KV (preferred) or env store.
  const settingsKeys = new Set<string>(SETTINGS_ENV_KEYS);
  const existingCreds = await readAllCredentialsFromKV().catch(
    () => ({}) as Record<string, string>
  );
  let existingEnv: Record<string, string> = {};
  try {
    const store = getEnvStore();
    existingEnv = await store.read();
  } catch {
    // Vercel without VERCEL_TOKEN: no env store accessible. Diff against KV
    // only — won't surface env-var-only keys but that's acceptable for the
    // import flow (worst case: we report "added" for a key that exists as
    // an env var the dashboard can't see).
  }

  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  for (const [k, v] of Object.entries(filtered)) {
    const current = existingCreds[k] ?? existingEnv[k] ?? null;
    if (current === null) added.push(k);
    else if (current !== v) updated.push(k);
    else unchanged.push(k);
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      mode: report.mode,
      diff: { added, updated, unchanged },
    });
  }

  // Refuse to write in modes where we can't durably persist. We perform the
  // mode check BEFORE any write so the response is consistent — partial
  // writes (settings succeed, creds rejected) would leave the user confused
  // about what landed where.
  if (report.mode === "kv-degraded") {
    return NextResponse.json(
      {
        ok: false,
        error: `KV unreachable (${report.error ?? "unknown"}). Import blocked to prevent partial writes.`,
        mode: report.mode,
      },
      { status: 503 }
    );
  }

  // Split: settings via instance config writer, rest via storage backend.
  const settingsToWrite: Record<string, string> = {};
  const credsToWrite: Record<string, string> = {};
  for (const [k, v] of Object.entries(filtered)) {
    if (settingsKeys.has(k)) settingsToWrite[k] = v;
    else credsToWrite[k] = v;
  }

  // Static mode: settings go through KV (which `getKVStore()` selects),
  // but in static mode the FS is read-only — `FilesystemKV.set()` would
  // throw EROFS. Refuse the whole import unless there's nothing to write
  // outside Vercel-API fallback. (We don't try to be clever and split
  // settings vs creds here — the user gets one clear error.)
  if (report.mode === "static") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Static mode — neither credentials nor settings can be persisted. Set them as deploy environment variables and redeploy, or set up Upstash Redis first.",
        mode: report.mode,
        partialDiff: { added, updated, unchanged },
      },
      { status: 422 }
    );
  }

  // Settings always go through saveInstanceConfig (KV-backed). At this
  // point mode is `kv` or `file`, both of which the KV writer handles.
  const writeErrors: string[] = [];
  if (Object.keys(settingsToWrite).length > 0) {
    try {
      await saveInstanceConfig({
        displayName: settingsToWrite.MYMCP_DISPLAY_NAME,
        timezone: settingsToWrite.MYMCP_TIMEZONE,
        locale: settingsToWrite.MYMCP_LOCALE,
        contextPath: settingsToWrite.MYMCP_CONTEXT_PATH,
      });
    } catch (err) {
      writeErrors.push(
        `Settings write failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (Object.keys(credsToWrite).length > 0) {
    try {
      if (report.mode === "kv") {
        await saveCredentialsToKV(credsToWrite);
      } else {
        // mode === "file"
        const store = getEnvStore();
        await store.write(credsToWrite);
      }
    } catch (err) {
      writeErrors.push(
        `Credential write failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (writeErrors.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        mode: report.mode,
        error: writeErrors.join("; "),
        partialDiff: { added, updated, unchanged },
      },
      { status: 500 }
    );
  }

  // Tell the registry to re-scan
  const { emit } = await import("@/core/events");
  emit("env.changed");

  return NextResponse.json({
    ok: true,
    mode: report.mode,
    added: added.length,
    updated: updated.length,
    unchanged: unchanged.length,
    diff: { added, updated, unchanged },
  });
}

export const POST = withBootstrapRehydrate(postHandler);
