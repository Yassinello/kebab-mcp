/**
 * composeRequestPipeline — PIPE-01.
 *
 * Koa-style middleware composition for Next.js route handlers. Replaces
 * the hand-rolled preamble (`await rehydrate()` → `const err =
 * checkAuth()` → `if (err) return err` → `const rl = await
 * checkRateLimit()` → …) that accumulated across the 6 entry-point
 * routes as v0.10 landed.
 *
 * Usage:
 *
 *   export const POST = composeRequestPipeline(
 *     [rehydrateStep, authStep("mcp"), rateLimitStep({ scope: "mcp", keyFrom: "token" })],
 *     async (ctx) => {
 *       // ctx.tenantId / ctx.tokenId / ctx.credentials all populated
 *       return Response.json({ ok: true });
 *     }
 *   );
 *
 * Ordering semantics (Koa):
 *   - Steps run in declaration order. Each receives `(ctx, next)`.
 *   - Calling `next()` yields to the downstream step / handler; not
 *     calling it short-circuits the chain (the step's Response is final).
 *   - Mutations to `ctx` are visible to downstream steps + the handler.
 *   - Errors propagate; no silent swallow (tripwire: tests/contract/
 *     no-silent-swallows).
 *
 * requestContext coupling (PIPE-03 correctness fix):
 *   The outer wrapper runs the whole chain inside
 *   `requestContext.run({ tenantId: initial })`. Steps that WRITE
 *   `ctx.tenantId` (i.e. `authStep`) re-enter a nested
 *   `requestContext.run({ tenantId: newId, credentials })` for their own
 *   `next()` so downstream steps — in particular `rateLimitStep` — see
 *   the resolved tenant via `getCurrentTenantId()`. This closes
 *   POST-V0.10-AUDIT §B.2: pre-Phase-41, `checkRateLimit` ran before
 *   `requestContext.run` and `getCurrentTenantId()` always returned
 *   `null`, keying every rate-limit bucket under `"global"`.
 */

import { requestContext } from "./request-context";
import type { PipelineContext, Step, PipelineHandler } from "./pipeline/types";

/**
 * Marker string recognized by `tests/contract/pipeline-coverage.test.ts`.
 * A route file that legitimately cannot join the pipeline (e.g. public
 * liveness endpoint with hard latency budget, OAuth callback with no
 * auth/rate-limit state) puts `// PIPELINE_EXEMPT: <reason ≥20 chars>`
 * in its first 10 lines.
 */
export const PIPELINE_EXEMPT_MARKER = "PIPELINE_EXEMPT:";

/**
 * Build a Next.js-compatible handler from an ordered step list plus a
 * terminal handler. The returned function accepts `(request, routeCtx?)`
 * and returns `Promise<Response>`.
 *
 * `routeCtx` is Next.js' second handler arg (the `{ params: Promise<...> }`
 * bag for dynamic routes). It is passed through verbatim on `ctx.routeParams`
 * so handler authors that care can read `const { name } = await ctx.routeParams.params`.
 */
export function composeRequestPipeline(
  steps: Step[],
  handler: PipelineHandler
): (request: Request, routeCtx?: unknown) => Promise<Response> {
  return async function pipelineHandler(request: Request, routeCtx?: unknown): Promise<Response> {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

    const ctx: PipelineContext = {
      request,
      routeParams: routeCtx,
      tenantId: null,
      tokenId: null,
      requestId,
      credentials: undefined,
    };

    // Right-to-left reduce so `dispatch()` kicks off step[0], whose
    // `next()` invokes the curried continuation for step[1], and so on.
    // The terminal continuation invokes the user handler.
    const dispatch: () => Promise<Response> = steps.reduceRight<() => Promise<Response>>(
      (next, step) => () => step(ctx, next),
      () => handler(ctx)
    );

    // Outer requestContext.run — guarantees `getCurrentTenantId()` is
    // callable from any step, even before authStep resolves a tenant.
    // Steps that RESOLVE a tenant re-enter `requestContext.run` so their
    // downstream continuation sees the updated ambient tenantId.
    return requestContext.run({ tenantId: ctx.tenantId, credentials: ctx.credentials }, dispatch);
  };
}
