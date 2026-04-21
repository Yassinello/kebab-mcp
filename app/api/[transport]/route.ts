import { createMcpHandler } from "mcp-handler";
import { withLogging } from "@/core/logging";
import { getEnabledPacks, logRegistryState } from "@/core/registry";
import { on } from "@/core/events";
import { VERSION } from "@/core/version";
import { getDisabledTools } from "@/core/tool-toggles";
import {
  composeRequestPipeline,
  rehydrateStep,
  firstRunGateStep,
  authStep,
  rateLimitStep,
  hydrateCredentialsStep,
  type PipelineContext,
} from "@/core/pipeline";

// NIT-03: Log the registry state once at module load, then re-log only
// when env.changed fires. Previous behavior logged on every MCP request,
// which dominated dev console output and produced log spam in production.
// v0.6 MED-2: guard the subscription with a globalThis flag so Next.js
// HMR re-evaluating this module doesn't accumulate listeners on each
// hot reload during development.
const TRANSPORT_SUBSCRIBED = Symbol.for("mymcp.transport.subscribed");
type GlobalWithFlag = typeof globalThis & { [TRANSPORT_SUBSCRIBED]?: boolean };
{
  const g = globalThis as GlobalWithFlag;
  if (!g[TRANSPORT_SUBSCRIBED]) {
    g[TRANSPORT_SUBSCRIBED] = true;
    logRegistryState();
    on("env.changed", logRegistryState);
  }
}

/**
 * Build a fresh MCP handler that reflects the current registry state.
 * Called per-request so that hot-env edits (via /api/config/env) are
 * picked up without needing a restart.
 *
 * The transport is connector-agnostic: it iterates enabled connectors
 * and registers their tools + optional prompts generically. Individual
 * connectors that need non-tool primitives (e.g., Skills exposing MCP
 * prompts) implement `ConnectorManifest.registerPrompts` — the transport
 * never imports from specific connector modules.
 *
 * Cost: a few ms to re-scan process.env + rebuild the tool list.
 *
 * v0.11 Phase 41: the credentials snapshot + requestContext wrapping are
 * now owned by the pipeline (`hydrateCredentialsStep` seeds the snapshot
 * and runs the chain under `runWithCredentials`). This function reads
 * `getHydratedCredentialSnapshot()` only for the per-tool handler's
 * inner `requestContext.run` wrap — the pipeline's credentials are the
 * authoritative source but legacy tool-handler code that reads from
 * ambient process.env still works (SEC-02 fallback).
 */
async function buildHandler(
  callerTokenId?: string | null,
  tenantId?: string | null,
  requestId?: string | null
) {
  return createMcpHandler(
    (server) => {
      const enabledPacks = getEnabledPacks();

      for (const pack of enabledPacks) {
        for (const tool of pack.manifest.tools) {
          const desc = tool.deprecated
            ? `[DEPRECATED: ${tool.deprecated}] ${tool.description}`
            : tool.description;
          server.tool(
            tool.name,
            desc,
            tool.schema,
            withLogging(
              tool.name,
              async (params) => {
                // HIGH-2: Check per-tool disable at invocation time (not
                // registration time) so toggles take effect immediately
                // even on long-lived sessions.
                const currentDisabled = await getDisabledTools();
                if (currentDisabled.has(tool.name)) {
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: JSON.stringify({
                          error: `Tool "${tool.name}" is currently disabled`,
                        }),
                      },
                    ],
                    isError: true,
                  };
                }
                // v0.11 Phase 41: the pipeline wraps the whole request in
                // `runWithCredentials` (hydrateCredentialsStep) and the
                // outer / authStep's nested `requestContext.run` already
                // carries tenantId. The AsyncLocalStorage closure covers
                // the mcp-handler tool invocation, so no additional wrap
                // is needed here. The extra run below is kept as a
                // defense in depth for tool handlers that may execute
                // outside the closure (e.g. through fire-and-forget
                // timers), and it is idempotent — runWithCredentials
                // merges creds, and the outer tenantId is preserved.
                void tenantId; // silence unused (kept for signature compatibility)
                // Kept explicit so a connector author reading this file sees
                // the intended behavior.
                return tool.handler(params);
              },
              callerTokenId,
              pack.manifest.id,
              requestId
            )
          );
        }

        // Non-tool primitives (MCP prompts, resources) — optional per
        // connector. Each connector handles its own registration logic.
        if (pack.manifest.registerPrompts) {
          try {
            const maybePromise = pack.manifest.registerPrompts(server);
            // Fire and forget if async — the transport is synchronous at
            // this level; per-request rebuild tolerates late promise resolution.
            if (maybePromise && typeof (maybePromise as Promise<void>).then === "function") {
              (maybePromise as Promise<void>).catch((err) =>
                console.info(
                  `[Kebab MCP] ${pack.manifest.id}.registerPrompts rejected: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                )
              );
            }
          } catch (err) {
            console.info(
              `[Kebab MCP] ${pack.manifest.id}.registerPrompts threw: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }
      }
    },
    {
      serverInfo: {
        name: "Kebab MCP",
        version: VERSION,
      },
    },
    {
      basePath: "/api",
      maxDuration: 60,
    }
  );
}

/**
 * Pipeline handler for the MCP transport. The pipeline steps above have
 * already: rehydrated bootstrap state, gated first-run mode, verified
 * MCP auth (and written tokenId + tenantId into ctx + requestContext),
 * enforced rate-limit quotas, and hydrated KV credentials into the
 * ambient `runWithCredentials` closure. This handler just builds and
 * invokes the mcp-handler, then echoes x-request-id.
 *
 * Note: legacy tool handlers that read connector credentials via
 * `process.env` / `getCredential()` work unchanged — the ambient
 * credentials snapshot carries them through AsyncLocalStorage. See
 * credential-store.ts SEC-02 for the resolution order.
 */
async function transportHandler(ctx: PipelineContext): Promise<Response> {
  const mcpHandler = await buildHandler(ctx.tokenId, ctx.tenantId, ctx.requestId);
  const response = await mcpHandler(ctx.request);
  response.headers.set("x-request-id", ctx.requestId);
  return response;
}

const pipeline = composeRequestPipeline(
  [
    rehydrateStep,
    firstRunGateStep,
    authStep("mcp"),
    rateLimitStep({ scope: "mcp", keyFrom: "token" }),
    hydrateCredentialsStep,
  ],
  transportHandler
);

export { pipeline as GET, pipeline as POST, pipeline as DELETE };
