import { NextResponse } from "next/server";
import { getContextKVStore } from "@/core/request-context";
import { dualReadKV } from "@/core/migrations/v0.11-tenant-scope";
import { getInstanceConfigAsync, saveInstanceConfig } from "@/core/config";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";

/**
 * GET /api/config/context
 * PUT /api/config/context
 *
 * Read or write the personal-context file in either of two modes:
 * - inline: markdown stored under KV key `mymcp:context:inline`
 * - vault:  path stored as MYMCP_CONTEXT_PATH env var (the file itself
 *           lives in the user's Obsidian vault and is fetched via the
 *           vault connector at runtime)
 *
 * The `mode` flag itself is stored under `mymcp:context:mode`.
 *
 * **Phase 42 (TEN-05) — per-tenant Claude persona:**
 *
 * Reads + writes flow through `getContextKVStore()`. The bare keys
 * `mymcp:context:inline` and `mymcp:context:mode` auto-wrap to
 * `tenant:<id>:mymcp:context:*` under a tenant context. Each tenant
 * gets its own inline context / persona.
 *
 * Legacy un-wrapped keys (`mymcp:context:inline`, `mymcp:context:mode`)
 * are read transparently via `dualReadKV` during the 2-release
 * transition window — pre-v0.11 operator deploys keep seeing their
 * inline context on the first post-upgrade load.
 *
 * `saveInstanceConfig({ contextPath })` stays operator-wide per Phase
 * 42 scope decision; `src/core/config.ts` `settings:*` keys are
 * intentionally global. A future phase can layer a tenant-aware
 * wrapper without reworking this callsite.
 */

const KV_INLINE = "mymcp:context:inline";
const KV_MODE = "mymcp:context:mode";

interface ContextState {
  mode: "inline" | "vault";
  inline: string;
  vaultPath: string;
}

async function getHandler() {
  const kv = getContextKVStore();
  // Phase 42 / TEN-05: dual-read both context keys so pre-v0.11
  // operators still see their inline context on the first post-upgrade
  // load. Writes (PUT) go only to the new (tenant-wrapped) keys.
  const [storedMode, storedInline, cfg] = await Promise.all([
    dualReadKV(kv, KV_MODE, KV_MODE),
    dualReadKV(kv, KV_INLINE, KV_INLINE),
    getInstanceConfigAsync(),
  ]);

  const hasVaultPath = !!cfg.contextPath && cfg.contextPath !== "System/context.md";
  const mode: "inline" | "vault" =
    storedMode === "vault" || storedMode === "inline"
      ? storedMode
      : hasVaultPath
        ? "vault"
        : "inline";

  return NextResponse.json({
    mode,
    inline: storedInline ?? "",
    vaultPath: cfg.contextPath ?? "",
  } satisfies ContextState);
}

async function putHandler(ctx: PipelineContext) {
  const request = ctx.request;

  let body: Partial<ContextState>;
  try {
    body = (await request.json()) as Partial<ContextState>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const mode = body.mode === "vault" ? "vault" : "inline";
  const inline = typeof body.inline === "string" ? body.inline : "";
  const vaultPath = typeof body.vaultPath === "string" ? body.vaultPath.trim() : "";

  // Hard cap to prevent abuse — context files should be short.
  if (inline.length > 64 * 1024) {
    return NextResponse.json(
      { ok: false, error: "Inline context too large (max 64KB)" },
      { status: 413 }
    );
  }

  const kv = getContextKVStore();
  await kv.set(KV_MODE, mode);

  if (mode === "inline") {
    // Active mode: inline. Persist the content. Reset the KV-backed
    // contextPath to the default so stale vault paths don't pile up.
    await kv.set(KV_INLINE, inline);
    // instance config stays operator-wide per Phase 42 scope decision;
    // per-tenant contextPath can be layered later via a tenant-aware
    // wrapper without reworking this call.
    await saveInstanceConfig({ contextPath: "System/context.md" });
  } else {
    // Active mode: vault. Mirror the path into the KV-backed setting so
    // the my_context tool can resolve it, and clear any stale inline KV.
    await kv.delete(KV_INLINE);
    if (vaultPath) {
      await saveInstanceConfig({ contextPath: vaultPath });
    }
  }

  return NextResponse.json({ ok: true, mode });
}

export const GET = withAdminAuth(getHandler);
export const PUT = withAdminAuth(putHandler);
