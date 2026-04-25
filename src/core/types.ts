import { z } from "zod";

/**
 * Core types for Kebab MCP framework.
 * These are framework-level types — no instance-specific values.
 */

/** Result shape returned by all tool handlers — index signature for MCP SDK compatibility */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
  /** Machine-readable error code from McpToolError — present on error responses only */
  errorCode?: string;
  /**
   * If set, the transport will stream chunks to the client instead of
   * returning the full content at once. When the MCP SDK does not support
   * native streaming tool results, `withLogging` collects chunks into a
   * buffer and sends the full result when the stream ends. This still
   * allows tools to produce data progressively without holding everything
   * in memory.
   */
  stream?: AsyncIterable<string>;
  /**
   * Machine-readable structured output for tools that declare an outputSchema.
   * Populated by the api-connections connector handler when the response body
   * parses as valid JSON and result.truncated is false.
   * Passed through to the MCP client via server.registerTool().
   * Must be a plain JSON object to satisfy the MCP SDK CallToolResult contract.
   */
  structuredContent?: Record<string, unknown>;
}

/** Single tool definition — the unit of functionality.
 *
 * Stored heterogeneously inside `ConnectorManifest.tools` so its handler takes
 * `Record<string, unknown>` and the schema is `z.ZodRawShape`. Tool authors
 * who want compile-time-typed `args` should reach for the generic
 * `defineTool()` helper below, which infers the exact args type from the
 * schema literal and widens back to this storage shape.
 */
export interface ToolDefinition {
  /** MCP tool name (e.g., "gmail_inbox") */
  name: string;
  /** MCP tool description shown to the LLM */
  description: string;
  /** Zod schema for input validation (shape passed to `z.object(...)`) */
  schema: z.ZodRawShape;
  /** Handler function */
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * Optional JSON Schema for the tool's structured output.
   * When present, the MCP transport uses server.registerTool() instead of
   * the legacy server.tool() — enabling structured content in ToolResult.
   * Only applies to custom API tools (api-connections connector).
   */
  outputSchema?: Record<string, unknown>;
  /** Short one-line summary (optional, for docs/dashboard) */
  summary?: string;
  /** Usage example (optional, for docs/dashboard) */
  example?: string;
  /** Deprecation notice — if set, tool is marked deprecated in dashboard + MCP description */
  deprecated?: string;
  /**
   * Write-side-effect flag. REQUIRED — every tool must declare its intent
   * explicitly. When true, the sandbox and dashboard require confirmation
   * before invoking. When false, the tool is read-only / side-effect-free.
   * No name-based regex is used; tool authors opt in explicitly.
   *
   * Policy (as of v0.5):
   * - `true` when the tool MUTATES external state — creates, updates,
   *   deletes, sends messages, posts comments, moves files, etc.
   * - `false` when the tool reads / queries without modifying anything.
   *
   * NOT covered by this flag (future work, see TECH-IMPROVEMENTS report):
   * - Paid APIs that cost money per call but don't mutate state (e.g.
   *   Apify scrapers, Browserbase sessions). These are currently
   *   `destructive: false`. A separate `paid: boolean` or `cost: "free" |
   *   "paid"` flag is tracked for v0.6+.
   * - Rate-limited APIs where the risk is quota exhaustion rather than
   *   mutation — same bucket, same future work.
   */
  destructive: boolean;
}

/**
 * Typed tool definition input — used by `defineTool()` to give handler
 * authors compile-time-checked `args` inferred from the schema literal.
 */
export interface TypedToolDefinition<TSchema extends z.ZodRawShape> {
  name: string;
  description: string;
  schema: TSchema;
  handler: (args: z.infer<z.ZodObject<TSchema>>) => Promise<ToolResult>;
  summary?: string;
  example?: string;
  deprecated?: string;
  destructive: boolean;
}

/**
 * Helper that infers TSchema from the given schema literal so handlers
 * get a fully-typed `args` parameter, while widening the result back to
 * the default `ToolDefinition` for storage in a pack's `tools` array.
 */
export function defineTool<TSchema extends z.ZodRawShape>(
  def: TypedToolDefinition<TSchema>
): ToolDefinition {
  return def as unknown as ToolDefinition;
}

/** Result of a connector-level testConnection() call. */
export interface TestConnectionResult {
  ok: boolean;
  message: string;
  /** Optional debug detail shown under the ok/fail message in the wizard. */
  detail?: string;
}

/** Pack manifest — groups related tools */
export interface ConnectorManifest {
  /** Pack identifier (e.g., "google", "vault") */
  id: string;
  /** Human-readable label (e.g., "Google Workspace") */
  label: string;
  /** Short description of what this pack provides */
  description: string;
  /**
   * Env vars that MUST be present to activate this pack (AND semantics).
   * For custom logic (OR semantics, at-least-one, etc.), use `isActive` instead.
   */
  requiredEnvVars: string[];
  /**
   * Optional custom activation predicate. If defined, it overrides the default
   * `requiredEnvVars` check. Receives the current process env and returns
   * `{ active: boolean, reason?: string }` — `reason` is shown on the dashboard
   * when the pack is inactive.
   */
  isActive?: ((env: NodeJS.ProcessEnv) => { active: boolean; reason?: string }) | undefined;
  /** All tools in this pack */
  tools: ToolDefinition[];
  /**
   * Optional async hook invoked by the MCP transport before it iterates
   * `tools` for registration. Connectors whose tool set is dynamic and
   * persisted outside the process (KV-backed user-defined tools) use
   * this to prime a synchronous cache that `tools` reads from.
   *
   * Without this hook, such connectors silently expose 0 tools to MCP
   * clients on cold lambdas until `/api/admin/status` (or any other
   * code path that calls `diagnose()`) fires — because `tools` is a
   * synchronous getter that cannot await the backing store.
   *
   * Called once per request cycle on the transport. Idempotent.
   */
  refresh?: (() => Promise<void>) | undefined;
  /** Optional async health check — verifies credentials actually work */
  diagnose?: (() => Promise<{ ok: boolean; message: string }>) | undefined;
  /**
   * Optional pre-install credential test used by the /welcome and
   * /config setup flows. Receives the credential draft the user typed
   * into the wizard (keys mirror `requiredEnvVars`) and returns a
   * simple ok/message pair with optional debug detail. Unlike
   * `diagnose()` (which runs against `process.env`), this is called
   * BEFORE the credentials have been persisted — so implementations
   * must read from the `credentials` argument, not from env.
   */
  testConnection?:
    | ((credentials: Record<string, string>) => Promise<TestConnectionResult>)
    | undefined;
  /**
   * Optional markdown guide shown in `/config → Packs` for per-pack credential
   * instructions that go beyond a simple key/value form (e.g., per-source
   * cookies for the paywall pack).
   */
  guide?: string | undefined;
  /**
   * When true, this connector is considered framework-core (e.g., Skills,
   * Admin) — still registered and exposing tools, but hidden from the
   * user-facing Connectors page since it isn't a user-configurable
   * integration.
   */
  core?: boolean | undefined;
  /**
   * Optional hook for registering non-tool MCP primitives (prompts,
   * resources) on the MCP server instance. Called by the transport
   * after tool registration for every enabled connector.
   *
   * The `server` parameter is typed loosely as `unknown` to avoid
   * leaking the `mcp-handler` internals into the core types — connector
   * authors cast it to the specific shape they need. This keeps the
   * framework-level primitive independent of any one transport
   * implementation.
   */
  registerPrompts?: ((server: unknown) => void | Promise<void>) | undefined;
  /**
   * Phase 50 / MCP-01 — Optional MCP resources provider.
   *
   * When present, the transport calls `registerResources(server, providers)`
   * from `@/core/resources` after tool registration to wire up the
   * `resources/list` and `resources/read` handlers. See
   * `src/connectors/vault/resources.ts` for the reference implementation.
   */
  resources?: import("./resources").ResourceProvider | undefined;
}

/** Resolved state of a pack at runtime */
export interface ConnectorState {
  manifest: ConnectorManifest;
  enabled: boolean;
  reason: string;
}

/** Instance-level configuration from env vars */
export interface InstanceConfig {
  timezone: string;
  locale: string;
  displayName: string;
  contextPath: string;
}
