/**
 * Unit tests for `src/core/pipeline.ts` + `src/core/pipeline/rehydrate-step.ts`
 * — PIPE-01 + PIPE-07 Task 1 coverage.
 *
 * Behaviors:
 *   1. `composeRequestPipeline([], handler)` returns a Next.js-compatible
 *      `(req, ctx?) => Promise<Response>`.
 *   2. Steps run in declaration order; `next()` invokes the next step.
 *   3. Not calling `next()` short-circuits the chain (step's response
 *      becomes the final response).
 *   4. Step errors propagate (no silent swallow).
 *   5. The handler runs inside `requestContext.run({ tenantId })` —
 *      a step that writes `ctx.tenantId = 'acme'` via a nested
 *      `requestContext.run` is visible to `getCurrentTenantId()` inside
 *      downstream steps and the handler.
 *   6. `rehydrateStep` calls `rehydrateBootstrapAsync()` once per request
 *      and triggers `runV010TenantPrefixMigration` once per process.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const rehydrateMock = vi.fn(async () => {});
const migrationMock = vi.fn(async () => {});

vi.mock("@/core/first-run", () => ({
  rehydrateBootstrapAsync: () => rehydrateMock(),
}));

vi.mock("@/core/migrations/v0.10-tenant-prefix", () => ({
  runV010TenantPrefixMigration: () => migrationMock(),
}));

// Import after mocks.
import { composeRequestPipeline, PIPELINE_EXEMPT_MARKER } from "@/core/pipeline";
import type { PipelineContext, Step } from "@/core/pipeline/types";
import { rehydrateStep, __resetRehydrateStepForTests } from "@/core/pipeline/rehydrate-step";
import { requestContext, getCurrentTenantId } from "@/core/request-context";

function makeRequest(url = "https://test.local/api/x", init?: RequestInit): Request {
  return new Request(url, { method: "GET", ...init });
}

describe("PIPELINE_EXEMPT_MARKER", () => {
  it("exports the documented marker string", () => {
    expect(PIPELINE_EXEMPT_MARKER).toBe("PIPELINE_EXEMPT:");
  });
});

describe("composeRequestPipeline (PIPE-01)", () => {
  it("with empty steps invokes the handler directly", async () => {
    const handler = vi.fn(async () => new Response("ok", { status: 200 }));
    const pipeline = composeRequestPipeline([], handler);
    const res = await pipeline(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("runs steps in declaration order and forwards the handler response", async () => {
    const order: string[] = [];
    const stepA: Step = async (_c, next) => {
      order.push("A-before");
      const res = await next();
      order.push("A-after");
      return res;
    };
    const stepB: Step = async (_c, next) => {
      order.push("B-before");
      const res = await next();
      order.push("B-after");
      return res;
    };
    const handler = async () => {
      order.push("handler");
      return new Response("hi", { status: 200 });
    };

    const pipeline = composeRequestPipeline([stepA, stepB], handler);
    const res = await pipeline(makeRequest());
    expect(res.status).toBe(200);
    expect(order).toEqual(["A-before", "B-before", "handler", "B-after", "A-after"]);
  });

  it("short-circuits when a step does not call next()", async () => {
    const handler = vi.fn(async () => new Response("never", { status: 200 }));
    const block: Step = async () => new Response("blocked", { status: 403 });

    const pipeline = composeRequestPipeline([block], handler);
    const res = await pipeline(makeRequest());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("blocked");
    expect(handler).not.toHaveBeenCalled();
  });

  it("propagates errors from steps (no silent swallow)", async () => {
    const boom: Step = async () => {
      throw new Error("boom");
    };
    const handler = vi.fn(async () => new Response("never"));
    const pipeline = composeRequestPipeline([boom], handler);
    await expect(pipeline(makeRequest())).rejects.toThrow("boom");
    expect(handler).not.toHaveBeenCalled();
  });

  it("propagates errors from the terminal handler", async () => {
    const handler = async () => {
      throw new Error("handler-fail");
    };
    const pipeline = composeRequestPipeline([], handler);
    await expect(pipeline(makeRequest())).rejects.toThrow("handler-fail");
  });

  it("seeds ctx with request + requestId (from header or generated)", async () => {
    let seen: PipelineContext | null = null;
    const capture: Step = async (ctx, next) => {
      seen = ctx;
      return next();
    };
    const handler = async () => new Response("ok");
    const pipeline = composeRequestPipeline([capture], handler);

    const req = makeRequest("https://test.local/x", {
      headers: { "x-request-id": "client-req-123" },
    });
    await pipeline(req);
    expect(seen).not.toBeNull();
    expect(seen!.request).toBe(req);
    expect(seen!.requestId).toBe("client-req-123");
    expect(seen!.tenantId).toBeNull();
    expect(seen!.tokenId).toBeNull();
  });

  it("generates a request id when none is provided", async () => {
    let seen: string | null = null;
    const capture: Step = async (ctx, next) => {
      seen = ctx.requestId;
      return next();
    };
    const pipeline = composeRequestPipeline([capture], async () => new Response("ok"));
    await pipeline(makeRequest());
    expect(seen).not.toBeNull();
    expect(seen!.length).toBeGreaterThan(0);
  });

  it("passes routeCtx through as ctx.routeParams", async () => {
    let seen: PipelineContext | null = null;
    const capture: Step = async (ctx, next) => {
      seen = ctx;
      return next();
    };
    const pipeline = composeRequestPipeline([capture], async () => new Response("ok"));
    const fakeRouteCtx = { params: Promise.resolve({ name: "slack" }) };
    await pipeline(makeRequest(), fakeRouteCtx);
    expect(seen).not.toBeNull();
    expect(seen!.routeParams).toBe(fakeRouteCtx);
  });

  it("the handler sees `getCurrentTenantId()` set by a prior step via nested requestContext.run", async () => {
    // authStep-equivalent: resolve a tenant and re-enter requestContext.run
    // for the continuation. This is the PIPE-03 correctness contract.
    const setTenant: Step = async (ctx, next) => {
      ctx.tenantId = "acme";
      return requestContext.run({ tenantId: "acme" }, next);
    };
    let tenantSeenByDownstreamStep: string | null = "unset";
    let tenantSeenByHandler: string | null = "unset";
    const observe: Step = async (_c, next) => {
      tenantSeenByDownstreamStep = getCurrentTenantId();
      return next();
    };
    const handler = async () => {
      tenantSeenByHandler = getCurrentTenantId();
      return new Response("ok", { status: 200 });
    };

    const pipeline = composeRequestPipeline([setTenant, observe], handler);
    await pipeline(makeRequest());
    expect(tenantSeenByDownstreamStep).toBe("acme");
    expect(tenantSeenByHandler).toBe("acme");
  });

  it("without the nested re-entry, downstream steps still see the OUTER null tenant (documents the contract)", async () => {
    // A step that writes ctx.tenantId but does NOT re-enter requestContext.run
    // fails to propagate the tenant to getCurrentTenantId(). This isn't a
    // bug in composeRequestPipeline — it's the contract authStep is
    // required to honor (see authStep JSDoc).
    const writeWithoutRun: Step = async (ctx, next) => {
      ctx.tenantId = "should-not-leak";
      return next();
    };
    let tenantSeen: string | null = "unset";
    const observe: Step = async (_c, next) => {
      tenantSeen = getCurrentTenantId();
      return next();
    };
    const pipeline = composeRequestPipeline(
      [writeWithoutRun, observe],
      async () => new Response("ok")
    );
    await pipeline(makeRequest());
    expect(tenantSeen).toBeNull();
  });

  it("each request gets its own ctx — no cross-request leak (AsyncLocalStorage scoping)", async () => {
    const recorded: (string | null)[] = [];
    const stepA: Step = async (ctx, next) => {
      ctx.tenantId = "alpha";
      return requestContext.run({ tenantId: "alpha" }, next);
    };
    const stepB: Step = async (ctx, next) => {
      ctx.tenantId = "beta";
      return requestContext.run({ tenantId: "beta" }, next);
    };
    const observe = async () => {
      recorded.push(getCurrentTenantId());
      return new Response("ok");
    };
    const pA = composeRequestPipeline([stepA], observe);
    const pB = composeRequestPipeline([stepB], observe);

    await Promise.all([pA(makeRequest()), pB(makeRequest())]);
    expect(recorded.sort()).toEqual(["alpha", "beta"]);
  });
});

describe("rehydrateStep (PIPE-07)", () => {
  beforeEach(() => {
    rehydrateMock.mockReset();
    rehydrateMock.mockResolvedValue(undefined);
    migrationMock.mockReset();
    migrationMock.mockResolvedValue(undefined);
    __resetRehydrateStepForTests();
  });

  it("awaits rehydrateBootstrapAsync before invoking next()", async () => {
    const sequence: string[] = [];
    rehydrateMock.mockImplementationOnce(async () => {
      sequence.push("rehydrate");
    });
    const nextStep: Step = async () => {
      sequence.push("next");
      return new Response("ok");
    };

    const pipeline = composeRequestPipeline([rehydrateStep, nextStep], async () => {
      sequence.push("handler");
      return new Response("final");
    });
    await pipeline(makeRequest());
    expect(sequence).toEqual(["rehydrate", "next"]);
  });

  it("calls rehydrateBootstrapAsync exactly once per request", async () => {
    const pipeline = composeRequestPipeline([rehydrateStep], async () => new Response("ok"));
    await pipeline(makeRequest());
    await pipeline(makeRequest());
    expect(rehydrateMock).toHaveBeenCalledTimes(2);
  });

  it("fires the one-shot migration only on the first request per process", async () => {
    const pipeline = composeRequestPipeline([rehydrateStep], async () => new Response("ok"));
    await pipeline(makeRequest());
    await pipeline(makeRequest());
    await pipeline(makeRequest());
    expect(migrationMock).toHaveBeenCalledTimes(1);
  });

  it("__resetRehydrateStepForTests() re-arms the one-shot migration", async () => {
    const pipeline = composeRequestPipeline([rehydrateStep], async () => new Response("ok"));
    await pipeline(makeRequest());
    expect(migrationMock).toHaveBeenCalledTimes(1);
    __resetRehydrateStepForTests();
    await pipeline(makeRequest());
    expect(migrationMock).toHaveBeenCalledTimes(2);
  });

  it("rehydrate errors propagate (no silent swallow)", async () => {
    rehydrateMock.mockRejectedValueOnce(new Error("rehydrate-boom"));
    const pipeline = composeRequestPipeline([rehydrateStep], async () => new Response("ok"));
    await expect(pipeline(makeRequest())).rejects.toThrow("rehydrate-boom");
  });

  it("migration errors do NOT reject the wrapped handler (fire-and-forget)", async () => {
    migrationMock.mockRejectedValueOnce(new Error("migration-boom"));
    const pipeline = composeRequestPipeline([rehydrateStep], async () => new Response("ok"));
    const res = await pipeline(makeRequest());
    expect(res.status).toBe(200);
  });
});
