/**
 * Structured error system for Kebab MCP tool handlers.
 * All packs should use McpToolError for machine-readable diagnostics.
 */

export const ErrorCode = {
  AUTH_FAILED: "AUTH_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  INVALID_INPUT: "INVALID_INPUT",
  EXTERNAL_API_ERROR: "EXTERNAL_API_ERROR",
  NOT_FOUND: "NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Thrown by `getRequiredConfig()` (src/core/config-facade.ts) when a
 * mandatory config key is missing / empty. Distinct from McpToolError
 * — this is a wiring error, not a tool runtime error. Catchable at the
 * pipeline layer to surface a 500 with a generic message while logging
 * the env var name server-side.
 *
 * Phase 48 / FACADE-01.
 */
export class McpConfigError extends Error {
  constructor(
    message: string,
    public readonly key?: string
  ) {
    super(message);
    this.name = "McpConfigError";
  }
}

export class McpToolError extends Error {
  readonly code: ErrorCodeType;
  readonly toolName: string;
  readonly userMessage: string;
  readonly retryable: boolean;
  /** Generic recovery hint safe to surface to the MCP client / LLM. */
  readonly recovery?: string;
  /**
   * Detailed recovery hint containing env var names or internal details.
   * Logged server-side only — never sent to the MCP client.
   */
  readonly internalRecovery?: string;

  constructor(opts: {
    code: ErrorCodeType;
    toolName: string;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    cause?: Error;
    recovery?: string;
    internalRecovery?: string;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = "McpToolError";
    this.code = opts.code;
    this.toolName = opts.toolName;
    this.userMessage = opts.userMessage ?? opts.message;
    this.retryable = opts.retryable ?? false;
    this.recovery = opts.recovery;
    this.internalRecovery = opts.internalRecovery;
  }
}
