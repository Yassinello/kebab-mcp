import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import { errorResponse } from "@/core/error-response";
import type { PipelineContext } from "@/core/pipeline";
import { detectStorageMode } from "@/core/storage-mode";
import { setDefaultAccount } from "@/core/connector-accounts";
import { resetCredentialHydration } from "@/core/credential-store";
import { emit } from "@/core/events";

/**
 * PUT /api/config/accounts/default — pin the default account for a
 * connector (MAUI-02). Body: { connector, slug } → { ok }.
 *
 * Same auth + tenant scoping as the parent route (`withAdminAuth`). The
 * store validates the pin lazily at resolve time: a slug that no longer
 * exists falls through to the count-based rules rather than mis-routing
 * (MACS-04), so we don't reject an unknown slug here — pinning is cheap
 * and idempotent.
 */

const SUPPORTED = new Set(["slack", "notion"]);

function isSupported(connector: unknown): connector is string {
  return typeof connector === "string" && SUPPORTED.has(connector);
}

async function putHandler(ctx: PipelineContext) {
  let body: { connector?: unknown; slug?: unknown };
  try {
    body = await ctx.request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { connector } = body;
  if (!isSupported(connector)) {
    return NextResponse.json(
      { ok: false, error: "Unsupported connector. Use one of: slack, notion." },
      { status: 400 }
    );
  }
  if (typeof body.slug !== "string" || !body.slug.trim()) {
    return NextResponse.json({ ok: false, error: "Missing slug." }, { status: 400 });
  }

  const report = await detectStorageMode();
  if (report.mode === "kv-degraded") {
    return NextResponse.json(
      {
        ok: false,
        mode: report.mode,
        error: `Storage temporarily unavailable: ${report.error ?? "KV unreachable"}. Saves are blocked to prevent data loss. Retry once KV recovers.`,
      },
      { status: 503 }
    );
  }

  try {
    await setDefaultAccount(connector, body.slug.trim());
    // Drop the stale hydrated index (now missing the new `default` field) so
    // the gate/snapshot re-reads KV. Mirrors the parent accounts route.
    resetCredentialHydration();
    emit("env.changed");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, { status: 500, route: "config/accounts/default" });
  }
}

export const PUT = withAdminAuth(putHandler);
