/**
 * /api/admin/vault — Kebab House phase 2 (VLT-04, VLT-06).
 *
 * GET  → which vault backend is in use and why, whether GitHub is
 *        configured, and the size of the KV vault.
 * POST → `{ action: "import-github", overwrite?: boolean }` copies the
 *        GitHub vault's Markdown files into the KV backend and returns a
 *        report (copied, overwritten, kept, unchanged, skipped, too large,
 *        failed; `incomplete` when the time budget ran out — run it again to
 *        resume). Notes present in both with different content are kept as
 *        they are in the KV unless `overwrite: true` (B2, 2026-11 audit).
 *        `{ action: "rebuild-index" }` rebuilds the KV vault index from the
 *        stored notes.
 *
 * The import never switches backend: that stays an explicit choice
 * (`KEBAB_VAULT_BACKEND=kv`, or removing the GitHub credentials).
 *
 * Admin-only. Credentials saved from the dashboard are hydrated into the
 * request context (hydrateCredentialsStep) so a PAT saved in /config is
 * visible to the import.
 */
import {
  composeRequestPipeline,
  rehydrateStep,
  authStep,
  hydrateCredentialsStep,
  type PipelineContext,
} from "@/core/pipeline";
import { errorResponse } from "@/core/error-response";
import { McpToolError } from "@/core/errors";
import { resolveVaultBackendKind } from "@/connectors/vault/lib/select";
import { kvVaultBackend, KV_VAULT_LIMITS } from "@/connectors/vault/lib/kv-backend";
import {
  importGithubVaultToKv,
  VaultImportConfigError,
} from "@/connectors/vault/lib/import-github";

// The import reads one GitHub file per request; its own time budget (45 s)
// stops before this and reports `incomplete`.
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

async function getHandler(): Promise<Response> {
  try {
    const choice = resolveVaultBackendKind();
    const tree = await kvVaultBackend.tree();
    const totalBytes = tree.reduce((n, f) => n + f.size, 0);
    return Response.json(
      {
        ok: true,
        backend: choice.kind,
        reason: choice.reason,
        githubConfigured: choice.githubConfigured,
        kv: { notes: tree.length, totalBytes, limits: KV_VAULT_LIMITS },
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    return errorResponse(err, { status: 500, route: "admin/vault" });
  }
}

async function postHandler(ctx: PipelineContext): Promise<Response> {
  let action = "";
  let overwrite = false;
  try {
    const body = (await ctx.request.json()) as { action?: unknown; overwrite?: unknown };
    action = typeof body.action === "string" ? body.action : "";
    overwrite = body.overwrite === true;
  } catch {
    // fall through to the 400 below
  }

  if (action === "rebuild-index") {
    try {
      const result = await kvVaultBackend.rebuildIndex();
      return Response.json({ ok: true, action, ...result }, { headers: NO_STORE });
    } catch (err) {
      return errorResponse(err, { status: 500, route: "admin/vault" });
    }
  }

  if (action === "import-github") {
    try {
      const report = await importGithubVaultToKv({ overwrite });
      const choice = resolveVaultBackendKind();
      return Response.json(
        { ok: true, action, backend: choice.kind, report },
        { headers: NO_STORE }
      );
    } catch (err) {
      if (err instanceof VaultImportConfigError) {
        return Response.json(
          { ok: false, error: "github_not_configured", message: err.message },
          { status: 400, headers: NO_STORE }
        );
      }
      // Typed vault errors (auth, not found) carry a message safe to show.
      if (err instanceof McpToolError) {
        return Response.json(
          { ok: false, error: "import_failed", message: err.userMessage },
          { status: 502, headers: NO_STORE }
        );
      }
      return errorResponse(err, { status: 502, route: "admin/vault" });
    }
  }

  return Response.json(
    {
      ok: false,
      error: "invalid_action",
      message: 'Expected { "action": "import-github" } or { "action": "rebuild-index" }.',
    },
    { status: 400, headers: NO_STORE }
  );
}

const steps = [rehydrateStep, authStep("admin"), hydrateCredentialsStep];

export const GET = composeRequestPipeline(steps, getHandler);
export const POST = composeRequestPipeline(steps, postHandler);
