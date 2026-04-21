/**
 * Pipeline types (PIPE-01).
 *
 * Koa-style middleware composition: `(ctx, next) => Promise<Response>`.
 * Each step either returns a short-circuit Response OR awaits `next()`
 * to invoke the next step in the chain.
 *
 * The `PipelineContext` is a mutable per-request bag that steps can
 * read and write. Step authors should prefer the typed slots
 * (`tenantId`, `tokenId`, `credentials`, `parsedBody`, `authKind`) over
 * the index-signature extension slot.
 *
 * See `src/core/pipeline.ts` for the `composeRequestPipeline(steps, handler)`
 * entry point and `src/core/pipeline/*-step.ts` for the 7 built-in steps.
 */

/**
 * Per-request context threaded through every step and the final handler.
 * Mutable — steps that need to publish state (authStep writes tenantId +
 * tokenId, bodyParseStep writes parsedBody, hydrateCredentialsStep writes
 * credentials) assign directly.
 */
export interface PipelineContext {
  /** The original Next.js Request object. */
  request: Request;
  /**
   * Next.js dynamic-route context (the `{ params: Promise<...> }` trailing
   * arg). `unknown` because the shape varies per-route; handler authors
   * cast to the expected type.
   */
  routeParams?: unknown;
  /**
   * Tenant id resolved from the request. `null` = default tenant
   * (single-tenant deploy or x-mymcp-tenant header absent).
   *
   * Written by `authStep` on the MCP path (it parses the tenant header
   * via `checkMcpAuth`). Written by route-local logic on the admin path
   * (admin/call reads `getTenantId(ctx.request)` in the handler).
   */
  tenantId: string | null;
  /**
   * sha256 first-8-hex of the authenticated token. Null for unauthenticated
   * paths (welcome/claim, welcome/init before claim) or auth kinds that
   * don't use tokens (cron uses CRON_SECRET which is tokenId'd into
   * `ctx.tokenId` by `authStep('cron')`).
   */
  tokenId: string | null;
  /**
   * Unique id for this request. Echoed on the response as `x-request-id`.
   * Read from `x-request-id` header if present, otherwise a random UUID.
   */
  requestId: string;
  /** Set by `authStep(kind)` so downstream steps can discriminate. */
  authKind?: "mcp" | "admin" | "cron";
  /**
   * Per-request credentials snapshot. Seeded by `hydrateCredentialsStep`;
   * consumed by the handler when it wraps its work in
   * `runWithCredentials(ctx.credentials, ...)`.
   */
  credentials?: Record<string, string>;
  /** Populated by `bodyParseStep`. JSON-parsed when possible, raw string on parse failure. */
  parsedBody?: unknown;
  /**
   * Free-form extension slot — step authors must prefer the typed slots
   * above. Documented for completeness; aim to land new fields as typed
   * properties instead of indexed lookups.
   */
  [key: string]: unknown;
}

/** Invokes the next step in the pipeline. Return its Response. */
export type StepNext = () => Promise<Response>;

/**
 * Pipeline step. Koa-style:
 *   - call `next()` to delegate downstream; await its Response
 *   - return a Response directly to short-circuit (auth fails, rate-limit exceeded)
 *   - throw an Error to propagate (no silent swallow; tripwire
 *     `tests/contract/no-silent-swallows` still applies)
 */
export type Step = (ctx: PipelineContext, next: StepNext) => Promise<Response>;

/**
 * Handler signature — the final "step" in the chain. Takes ctx, returns
 * a Response. Unlike a Step it has no `next()` because it's terminal.
 */
export type PipelineHandler = (ctx: PipelineContext) => Promise<Response>;

/**
 * Standard result shape some steps return when they want to signal success
 * with data rather than a Response. Currently unused by the 7 built-in
 * steps — present as a hook for future step authors. Kept in types.ts so
 * it doesn't orphan.
 */
export type StepResult = { ok: true } | { ok: false; response: Response };
