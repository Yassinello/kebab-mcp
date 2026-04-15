import { z } from "zod";

/**
 * Core types for MyMCP framework.
 * These are framework-level types — no instance-specific values.
 */

/** Result shape returned by all tool handlers — index signature for MCP SDK compatibility */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
  /** Machine-readable error code from McpToolError — present on error responses only */
  errorCode?: string;
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
  isActive?: (env: NodeJS.ProcessEnv) => { active: boolean; reason?: string };
  /** All tools in this pack */
  tools: ToolDefinition[];
  /** Optional async health check — verifies credentials actually work */
  diagnose?: () => Promise<{ ok: boolean; message: string }>;
  /**
   * Optional pre-install credential test used by the /welcome and
   * /config setup flows. Receives the credential draft the user typed
   * into the wizard (keys mirror `requiredEnvVars`) and returns a
   * simple ok/message pair with optional debug detail. Unlike
   * `diagnose()` (which runs against `process.env`), this is called
   * BEFORE the credentials have been persisted — so implementations
   * must read from the `credentials` argument, not from env.
   */
  testConnection?: (credentials: Record<string, string>) => Promise<TestConnectionResult>;
  /**
   * Optional markdown guide shown in `/config → Packs` for per-pack credential
   * instructions that go beyond a simple key/value form (e.g., per-source
   * cookies for the paywall pack).
   */
  guide?: string;
  /**
   * When true, this connector is considered framework-core (e.g., Skills,
   * Admin) — still registered and exposing tools, but hidden from the
   * user-facing Connectors page since it isn't a user-configurable
   * integration.
   */
  core?: boolean;
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
  registerPrompts?: (server: unknown) => void | Promise<void>;
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
