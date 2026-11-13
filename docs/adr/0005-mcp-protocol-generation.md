# ADR 0005 — MCP protocol generation: mcp-handler 2.x on SDK v2

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** Yassine (Founder)
- **Scope:** MCP transport (`app/api/[transport]/route.ts`), tool registration, resources, prompts — `docs/specs/kebab-house-phase-1.md` §6 (PRO-01, PRO-02) and §3 (TRU-01)

## Context

- The MCP specification changed generation on 2026-07-28: stateless, no session, a per-request `_meta` envelope (`io.modelcontextprotocol/protocolVersion`, `clientCapabilities`, optional `clientInfo`), standard headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) and `server/discover` instead of the `initialize` handshake.
- Kebab ran on `mcp-handler` 1.1 / `@modelcontextprotocol/sdk` 1.x, which only speaks the 2025 generation. `mcp-handler` 2.x requires `@modelcontextprotocol/server` 2.x.
- Claude and most clients still speak 2025; new clients will speak 2026. We need both, from one URL (`/api/mcp`).
- TRU-01 needs tool annotations, which means moving every tool from the variadic `server.tool()` to `registerTool()` anyway — the SDK v2 removed `server.tool()` / `server.prompt()`.

## Spike result (PRO-01)

The migration is feasible with no blocker:

- **Both generations, one handler.** `mcp-handler` 2.4 builds a fresh `McpServer` per request and serves 2026-07-28 natively and 2025-era Streamable HTTP through the SDK's stateless legacy fallback. Covered by `tests/api/transport-protocol-generations.test.ts` (real route, no mock): `initialize` (2025-06-18) → `tools/list` → `tools/call`, and `server/discover` → `tools/list` → `tools/call` with the 2026 envelope and headers.
- **Prompts, resources, `outputSchema`, annotations** all work in both generations: `registerPrompt` replaces `server.prompt`; the low-level `resources/list` / `resources/read` handlers now take the method string (`setRequestHandler("resources/list", …)`); tools with an `outputSchema` still return `structuredContent`; every tool carries `title` + `readOnlyHint` / `destructiveHint` / `openWorldHint`.
- **Tool schemas.** All 120 manifest input schemas convert to the same JSON Schema as before; the only difference is the SDK-chosen dialect URI (`$schema` is now JSON Schema 2020-12 instead of draft-07, the default the current spec mandates) and key order.
- **Tests.** Only the transport tests that mocked `mcp-handler`'s server shape (`server.tool`) needed updating; the rest of the suite is unaffected.

## Decision

1. **Migrate (PRO-02):** `mcp-handler@^2.4.0` + `@modelcontextprotocol/server@^2.4.0`; `@modelcontextprotocol/sdk` is no longer a direct dependency.
2. **One options object** for `createMcpHandler` (`serverInfo` = "Kebab House" + version, `instructions` built from the manifests). `maxDuration = 90` stays as Next route segment config.
3. **The route guards its own path.** `mcp-handler` 2.x ignores the pathname (1.x answered only `basePath + "/mcp"`), so the dynamic `[transport]` route serves only `transport === "mcp"` and answers every other value with the 1.x response: `404 Not found` (text/plain), after auth and rate limiting as before.
4. **TRU-01 annotations** are derived from the manifest by `src/core/tool-annotations.ts`: `title` (optional `ToolDefinition.title`, else derived from the name), `readOnlyHint = !destructive`, `destructiveHint = destructive`, `openWorldHint` (optional `ToolDefinition.openWorld`, else `false` for closed-world connectors — core ones (admin, context, skills) and the vault — and `true` for everything else, including API connections, Custom Tools and the webhook inbox). The contract snapshot records them.

## Consequences

- 2025 and 2026 clients both work against `/api/mcp`; no client-side change is required.
- Serving is stateless in both generations: `GET` and `DELETE` on `/api/mcp` (2025 session stream / termination) answer `405`. That was already the case with 1.x in stateless mode.
- The HTTP+SSE transport (2024-11-05: `/api/sse` + `/api/message`) is gone: those paths now answer `404`. In 1.x they only worked when `REDIS_URL` / `KV_URL` pointed at a Redis server (otherwise they failed); a client still on that transport must switch to Streamable HTTP at `/api/mcp`.
- `tools/list` now carries `title` and `annotations` for every tool, and input schemas declare the JSON Schema 2020-12 dialect.
- `.npmrc` (`legacy-peer-deps=true`) stays: the mcp-handler ↔ SDK peer conflict is gone, but a strict install still fails on Stagehand's bundled `openai@4` (optional peer `zod@^3`). `tests/contract/npmrc-legacy-peer-deps.test.ts` documents how to re-check.
- `@modelcontextprotocol/sdk` 1.x remains in `node_modules` as a transitive dependency of Stagehand; Kebab code must import from `@modelcontextprotocol/server` only.
