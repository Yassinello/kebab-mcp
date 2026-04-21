import { createMcpHandler } from "mcp-handler";
import { withLogging } from "@/core/logging";
import { checkMcpAuth, extractToken } from "@/core/auth";
import { isFirstRunMode } from "@/core/first-run";
import { checkRateLimit } from "@/core/rate-limit";
import { getEnabledPacks, logRegistryState } from "@/core/registry";
import { hydrateCredentialsFromKV, getHydratedCredentialSnapshot } from "@/core/credential-store";
import { on } from "@/core/events";
import { VERSION } from "@/core/version";
import { getDisabledTools } from "@/core/tool-toggles";
import { requestContext } from "@/core/request-context";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

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
 */
async function buildHandler(
  callerTokenId?: string | null,
  tenantId?: string | null,
  requestId?: string | null
) {
  // Hydrate KV-stored credentials into process.env before resolving
  // the registry. This ensures connectors whose credentials live in
  // Upstash (Vercel deployments) activate on cold start.
  await hydrateCredentialsFromKV();

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
                // CRITICAL-2: Wrap handler in request context so tool
                // handlers can access tenantId via getCurrentTenantId()
                // and get tenant-scoped KV via getContextKVStore().
                //
                // INFRA-05: AsyncLocalStorage.run() automatically scopes
                // the store to the callback lifetime. When the callback's
                // returned Promise settles (resolve or reject), the async
                // context is exited. Each request gets its own async
                // execution context, so there's no cross-contamination
                // between concurrent requests — no try/finally needed.
                //
                // SEC-02: seed the hydrated credential snapshot into the
                // request context so tool handlers reading via
                // `getCredential()` see KV-backed values even when
                // `process.env` does not. The map is request-scoped;
                // concurrent requests do not see each other's credentials.
                return requestContext.run(
                  {
                    tenantId: tenantId ?? null,
                    credentials: { ...getHydratedCredentialSnapshot() },
                  },
                  () => tool.handler(params)
                );
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

async function handler(request: Request): Promise<Response> {
  // Rehydrate is handled by withBootstrapRehydrate at the HOC boundary
  // (DUR-01). On Vercel without auto-magic, the welcome flow mints
  // MCP_AUTH_TOKEN into the minting lambda's process.env only — cold
  // lambdas that respond to Claude Desktop / Cursor / etc. have to pull
  // the token back from persistent storage on first request, otherwise
  // every MCP call returns 503 until someone manually pastes the token
  // into Vercel env vars. The durable-backend welcome flow writes the
  // bootstrap to KV at mint time (see persistBootstrapToKv), so this
  // restore is effectively instant on any request after setup completes.

  // Zero-config / first-run guard: if the instance has not yet been
  // initialized via /welcome, refuse all MCP traffic with a clear message.
  if (isFirstRunMode()) {
    return new Response(
      JSON.stringify({
        error: "Instance not yet initialized. Visit /welcome to set it up.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const { error: authError, tokenId, tenantId } = checkMcpAuth(request);
  if (authError) return authError;

  if (process.env.MYMCP_RATE_LIMIT_ENABLED === "true") {
    const token = extractToken(request);
    if (token) {
      const result = await checkRateLimit(token);
      if (!result.allowed) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(Math.ceil((result.resetAt - Date.now()) / 1000)),
            "X-RateLimit-Remaining": "0",
          },
        });
      }
    }
  }

  const mcpHandler = await buildHandler(tokenId, tenantId, requestId);
  const response = await mcpHandler(request);
  response.headers.set("x-request-id", requestId);
  return response;
}

const wrapped = withBootstrapRehydrate(handler);
export { wrapped as GET, wrapped as POST, wrapped as DELETE };
