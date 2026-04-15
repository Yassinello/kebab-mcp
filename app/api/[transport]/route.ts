import { createMcpHandler } from "mcp-handler";
import { withLogging } from "@/core/logging";
import { checkMcpAuth, extractToken } from "@/core/auth";
import { isFirstRunMode } from "@/core/first-run";
import { checkRateLimit } from "@/core/rate-limit";
import { getEnabledPacks, logRegistryState } from "@/core/registry";
import { on } from "@/core/events";
import { VERSION } from "@/core/version";

// NIT-03: Log the registry state once at module load, then re-log only
// when env.changed fires. Previous behavior logged on every MCP request,
// which dominated dev console output and produced log spam in production.
logRegistryState();
on("env.changed", logRegistryState);

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
function buildHandler(callerTokenId?: string | null) {
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
            withLogging(tool.name, async (params) => tool.handler(params), callerTokenId)
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
                  `[MyMCP] ${pack.manifest.id}.registerPrompts rejected: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                )
              );
            }
          } catch (err) {
            console.info(
              `[MyMCP] ${pack.manifest.id}.registerPrompts threw: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }
      }
    },
    {
      serverInfo: {
        name: "MyMCP",
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

  const { error: authError, tokenId } = checkMcpAuth(request);
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

  const mcpHandler = buildHandler(tokenId);
  return mcpHandler(request);
}

export { handler as GET, handler as POST, handler as DELETE };
