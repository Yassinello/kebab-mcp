import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { detectStorageMode, clearStorageModeCache } from "@/core/storage-mode";
import { getKVStore, kvScanAll } from "@/core/kv-store";
import { CRED_PREFIX, readAllCredentialsFromKV } from "@/core/credential-store";
import { getEnvStore } from "@/core/env-store";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * POST /api/storage/migrate
 * Body: { direction: 'file-to-kv' | 'kv-to-file', dryRun?: boolean }
 *
 * Moves credential data between backends. The default direction is the
 * common upgrade path — a user runs Docker with file storage, decides they
 * want multi-instance / backup, configures Upstash, and clicks "Migrate".
 *
 * The reverse (kv-to-file) is rare but supported for the
 * "I want to leave Upstash" case. KV → File only writes to disk if the FS
 * is actually writable; otherwise we 422 with a helpful message.
 *
 * dryRun returns the diff (which keys would be added/updated/skipped)
 * without touching the destination — used by the UI preview step.
 *
 * Atomic per-key: a partial failure mid-loop returns the keys that did
 * succeed in `migrated` and the failures in `errors` so the operator can
 * retry just those.
 */
async function postHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  let body: { direction?: string; dryRun?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const direction = body.direction;
  const dryRun = Boolean(body.dryRun);

  if (direction !== "file-to-kv" && direction !== "kv-to-file") {
    return NextResponse.json(
      { ok: false, error: "direction must be 'file-to-kv' or 'kv-to-file'" },
      { status: 400 }
    );
  }

  const report = await detectStorageMode();

  if (direction === "file-to-kv") {
    if (report.mode !== "kv") {
      return NextResponse.json(
        {
          ok: false,
          error: `Cannot migrate to KV — current mode is '${report.mode}'. Configure UPSTASH_REDIS_REST_URL/TOKEN first.`,
          mode: report.mode,
        },
        { status: 422 }
      );
    }

    // Source: filesystem env store
    const store = getEnvStore();
    let sourceVars: Record<string, string>;
    try {
      sourceVars = await store.read();
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Failed to read source env store: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 500 }
      );
    }

    // Existing KV creds — used to compute diff
    const existing = await readAllCredentialsFromKV();

    const toAdd: string[] = [];
    const toUpdate: string[] = [];
    const unchanged: string[] = [];

    for (const [k, v] of Object.entries(sourceVars)) {
      if (!v) continue;
      // Only migrate cred-like vars (caps + underscores). Skip Vercel meta,
      // Node runtime keys, etc. — same skip set as env-export.
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) continue;
      if (k.startsWith("VERCEL_") || k === "NODE_ENV" || k === "NEXT_RUNTIME") continue;

      if (!(k in existing)) toAdd.push(k);
      else if (existing[k] !== v) toUpdate.push(k);
      else unchanged.push(k);
    }

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        direction,
        sourceMode: "file",
        targetMode: report.mode,
        diff: { add: toAdd, update: toUpdate, unchanged },
      });
    }

    // Execute: write each add+update key individually so partial failures
    // surface per-key in the response (matches the docstring's "atomic
    // per-key" guarantee). We can't use saveCredentialsToKV's bulk
    // Promise.all because Promise.all rejects on first failure and we'd lose
    // visibility on which keys actually landed.
    const kv = getKVStore();
    const errors: { key: string; error: string }[] = [];
    let migrated = 0;
    for (const k of [...toAdd, ...toUpdate]) {
      try {
        await kv.set(`${CRED_PREFIX}${k}`, sourceVars[k]);
        process.env[k] = sourceVars[k];
        migrated++;
      } catch (err) {
        errors.push({
          key: k,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    clearStorageModeCache();
    return NextResponse.json({
      ok: errors.length === 0,
      direction,
      migrated,
      diff: { add: toAdd, update: toUpdate, unchanged },
      errors,
    });
  }

  // kv-to-file
  // We need TWO separate guarantees that the unified mode value can't give us
  // alone: (a) the KV source is reachable, (b) the FS destination is writable.
  // detectStorageMode() only reports one, so we re-probe the FS independently
  // here. The most common scenario for this branch is "Docker user with both
  // Upstash AND a writable volume who wants to leave Upstash" — both are live
  // simultaneously.
  if (report.mode !== "kv") {
    return NextResponse.json(
      {
        ok: false,
        error: `Cannot migrate from KV — KV is not the active source (mode: '${report.mode}'). Upstash env vars must be set and reachable.`,
        mode: report.mode,
      },
      { status: 422 }
    );
  }
  // Independent FS probe for destination — bypass the mode cache since we
  // need a fresh boolean answer about the *file* path, not the unified mode.
  const { promises: fsp } = await import("node:fs");
  const { randomBytes } = await import("node:crypto");
  const path = await import("node:path");
  const dataDir = process.env.MYMCP_KV_PATH
    ? path.dirname(process.env.MYMCP_KV_PATH)
    : path.resolve(process.cwd(), "data");
  const probePath = path.join(dataDir, `.mymcp-probe-${randomBytes(4).toString("hex")}`);
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(probePath, "probe", "utf-8");
    await fsp.unlink(probePath).catch(() => undefined);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Destination filesystem is not writable: ${err instanceof Error ? err.message : String(err)}. Migration aborted to avoid data loss.`,
      },
      { status: 422 }
    );
  }

  const kv = getKVStore();
  const credKeys = await kvScanAll(kv, `${CRED_PREFIX}*`);
  const credValues = kv.mget
    ? await kv.mget(credKeys)
    : await Promise.all(credKeys.map((k) => kv.get(k)));

  const sourceVars: Record<string, string> = {};
  for (let i = 0; i < credKeys.length; i++) {
    const envKey = credKeys[i].slice(CRED_PREFIX.length);
    const v = credValues[i];
    if (v) sourceVars[envKey] = v;
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      direction,
      sourceMode: "kv",
      targetMode: "file",
      diff: { add: Object.keys(sourceVars), update: [], unchanged: [] },
    });
  }

  const store = getEnvStore();
  let written: number;
  try {
    const result = await store.write(sourceVars);
    written = result.written;
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Write to env store failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 }
    );
  }

  clearStorageModeCache();
  return NextResponse.json({
    ok: true,
    direction,
    migrated: written,
    diff: { add: Object.keys(sourceVars), update: [], unchanged: [] },
    errors: [],
  });
}

export const POST = withBootstrapRehydrate(postHandler);
