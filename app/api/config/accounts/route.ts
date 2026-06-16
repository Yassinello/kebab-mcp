import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import { errorResponse } from "@/core/error-response";
import type { PipelineContext } from "@/core/pipeline";
import { detectStorageMode } from "@/core/storage-mode";
import { loadConnectorManifest } from "@/core/registry";
import { resetCredentialHydration } from "@/core/credential-store";
import { emit } from "@/core/events";
import {
  listAccounts,
  saveAccount,
  removeAccount,
  getDefaultAccount,
  type AccountTokenSet,
} from "@/core/connector-accounts";

/**
 * /api/config/accounts — multi-account CRUD over the phase-73 store
 * (`src/core/connector-accounts.ts`), NOT over env vars (MAUI-01..03).
 *
 * Auth + tenant scoping: `withAdminAuth` runs `[rehydrateStep,
 * authStep('admin')]`, identical to `/api/config/env`. Every store call
 * goes through `getContextKVStore()` inside connector-accounts.ts, so a
 * tenant-scoped admin (per the tenant header — see src/core/tenant.ts)
 * reads/writes only its own `tenant:<id>:cred:acct:*` namespace.
 *
 * Token hygiene (SEC): the GET path NEVER echoes token values — it
 * returns `{ slug, name }` pairs only. The POST path accepts tokens,
 * runs the connector's `testConnection()` first, and only persists on
 * success. Tokens are never reflected back in any response.
 *
 * This differs from the Unipile selector (which pins an account_id INSIDE
 * one token to an env var). Slack/Notion hold N separate token SETS in
 * KV; there is no env var to pin.
 */

/** Connectors this route manages. A single-token deployment of either
 * still works via the store's MACS-02 legacy-default synthesis. */
const SUPPORTED = new Set(["slack", "notion"]);

/** Required token keys per connector (POST validation). The store accepts
 * any AccountTokenSet, but we gate on the connector's primary key being
 * present so a blank form can't create a credential-less account. */
const PRIMARY_TOKEN_KEY: Record<string, string> = {
  slack: "SLACK_BOT_TOKEN",
  notion: "NOTION_API_KEY",
};

function isSupported(connector: unknown): connector is string {
  return typeof connector === "string" && SUPPORTED.has(connector);
}

/**
 * After an account mutation, invalidate the gate's view of credentials so
 * the connector re-gates immediately. Mirrors `/api/config/env`
 * (env/route.ts) which does the same after a legacy credential save:
 *   - resetCredentialHydration() drops the current tenant's hydrated
 *     snapshot so the next resolveRegistryAsync() re-reads KV (and sees the
 *     new/removed `cred:acct:<id>:__index__`);
 *   - emit("env.changed") clears the cached registry so the next page
 *     render re-runs the gate.
 * Without this, a freshly-added account would not flip the connector to
 * enabled until a cold lambda (Phase 76 — the slack/notion gate now reads
 * account presence, so this invalidation is load-bearing, not cosmetic).
 */
function invalidateGateAfterAccountChange(): void {
  resetCredentialHydration();
  emit("env.changed");
}

/**
 * Block writes when KV is degraded — mirrors `/api/config/env`. Without
 * this an account "save" would silently no-op (or half-write the index)
 * while the operator sees a success toast. Returns a Response to short
 * out, or null when writes are safe.
 */
async function refuseIfStorageDegraded(): Promise<Response | null> {
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
  return null;
}

/**
 * GET /api/config/accounts?connector=slack
 * → { ok, accounts: [{ slug, name }], default?: slug }
 *
 * Strips `tokens` from every account — only slug + name leave the server.
 */
async function getHandler(ctx: PipelineContext) {
  const url = new URL(ctx.request.url);
  const connector = url.searchParams.get("connector");
  if (!isSupported(connector)) {
    return NextResponse.json(
      { ok: false, error: "Unsupported connector. Use one of: slack, notion." },
      { status: 400 }
    );
  }

  try {
    const accounts = await listAccounts(connector);
    const def = await getDefaultAccount(connector);
    return NextResponse.json({
      ok: true,
      // Strip tokens — list only slug + name.
      accounts: accounts.map((a) => ({ slug: a.slug, name: a.name })),
      ...(def ? { default: def } : {}),
    });
  } catch (err) {
    return errorResponse(err, { status: 500, route: "config/accounts" });
  }
}

/**
 * POST /api/config/accounts
 * Body: { connector, tokens: AccountTokenSet, name? }
 * → tests the credentials FIRST; on failure { ok:false, error } (no save);
 *   on success derives the display name, saves, returns { ok, account:{slug,name} }.
 */
async function postHandler(ctx: PipelineContext) {
  let body: { connector?: unknown; tokens?: unknown; name?: unknown };
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

  const tokens = body.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return NextResponse.json({ ok: false, error: "Missing tokens object." }, { status: 400 });
  }
  // Coerce to a string-only token set; reject non-string token values.
  const tokenSet: AccountTokenSet = {};
  for (const [k, v] of Object.entries(tokens as Record<string, unknown>)) {
    if (typeof v !== "string") {
      return NextResponse.json(
        { ok: false, error: `Token ${k} must be a string.` },
        { status: 400 }
      );
    }
    const trimmed = v.trim();
    if (trimmed) tokenSet[k] = trimmed;
  }

  const primaryKey = PRIMARY_TOKEN_KEY[connector]!;
  if (!tokenSet[primaryKey]) {
    return NextResponse.json(
      { ok: false, error: `Missing required token ${primaryKey}.` },
      { status: 400 }
    );
  }

  const degraded = await refuseIfStorageDegraded();
  if (degraded) return degraded;

  try {
    const manifest = await loadConnectorManifest(connector);
    if (!manifest?.testConnection) {
      return NextResponse.json(
        { ok: false, error: "Connector does not support credential testing." },
        { status: 400 }
      );
    }

    // Test BEFORE saving — a bad token must never land in the store.
    const result = await manifest.testConnection(tokenSet);
    if (!result.ok) {
      return NextResponse.json({
        ok: false,
        error: result.detail || result.message || "Connection test failed.",
      });
    }

    // Derive the display name: provider-derived account_name wins, then a
    // caller-supplied name, then a generic fallback. Never an opaque id.
    const providedName = typeof body.name === "string" ? body.name.trim() : "";
    const name = result.account_name?.trim() || providedName || "account";

    const account = await saveAccount(connector, name, tokenSet);
    invalidateGateAfterAccountChange();
    return NextResponse.json({
      ok: true,
      account: { slug: account.slug, name: account.name },
    });
  } catch (err) {
    return errorResponse(err, { status: 500, route: "config/accounts" });
  }
}

/**
 * DELETE /api/config/accounts
 * Body: { connector, slug } → { ok }
 */
async function deleteHandler(ctx: PipelineContext) {
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

  const degraded = await refuseIfStorageDegraded();
  if (degraded) return degraded;

  try {
    await removeAccount(connector, body.slug.trim());
    invalidateGateAfterAccountChange();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, { status: 500, route: "config/accounts" });
  }
}

export const GET = withAdminAuth(getHandler);
export const POST = withAdminAuth(postHandler);
export const DELETE = withAdminAuth(deleteHandler);
