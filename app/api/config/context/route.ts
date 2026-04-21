import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { getKVStore } from "@/core/kv-store";
import { getInstanceConfigAsync, saveInstanceConfig } from "@/core/config";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

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
 */

const KV_INLINE = "mymcp:context:inline";
const KV_MODE = "mymcp:context:mode";

interface ContextState {
  mode: "inline" | "vault";
  inline: string;
  vaultPath: string;
}

async function getHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  const kv = getKVStore();
  const [storedMode, storedInline, cfg] = await Promise.all([
    kv.get(KV_MODE),
    kv.get(KV_INLINE),
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

async function putHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

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

  const kv = getKVStore();
  await kv.set(KV_MODE, mode);

  if (mode === "inline") {
    // Active mode: inline. Persist the content. Reset the KV-backed
    // contextPath to the default so stale vault paths don't pile up.
    await kv.set(KV_INLINE, inline);
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

export const GET = withBootstrapRehydrate(getHandler);
export const PUT = withBootstrapRehydrate(putHandler);
