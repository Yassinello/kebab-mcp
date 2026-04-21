/**
 * Transport pipeline regression — Phase 41 Task 3.
 *
 * Asserts that migrating `app/api/[transport]/route.ts` to
 * `composeRequestPipeline([...])` preserves the public contract:
 *  - unauthed → 401
 *  - first-run mode → 503 JSON
 *  - valid token + rate-limit tripped → 429 with Retry-After
 *  - per-tenant rate-limit bucket keyed by tenantId (CORRECTNESS-BUG-CLOSURE)
 *  - x-request-id echoed on response
 *
 * We import the pipeline exports directly (not the route file) to avoid
 * pulling mcp-handler during unit tests. The route file pattern is
 * re-verified in the pipeline-coverage contract test (Task 7).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  composeRequestPipeline,
  rehydrateStep,
  firstRunGateStep,
  authStep,
  rateLimitStep,
  hydrateCredentialsStep,
  type PipelineContext,
} from "@/core/pipeline";
import { __resetFirstRunForTests } from "@/core/first-run";
import { __resetInMemoryRateLimitForTests } from "@/core/rate-limit";
import { __resetRehydrateStepForTests } from "@/core/pipeline";
import { getCurrentTenantId } from "@/core/request-context";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_KEYS = [
  "MCP_AUTH_TOKEN",
  "MCP_AUTH_TOKEN_ACME",
  "MYMCP_RATE_LIMIT_ENABLED",
  "MYMCP_RATE_LIMIT_INMEMORY",
  "MYMCP_RATE_LIMIT_RPM",
  "VERCEL",
];
function snap(): Record<string, string | undefined> {
  const o: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) o[k] = process.env[k];
  return o;
}
function restore(s: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function buildTransportPipeline(handler: (ctx: PipelineContext) => Promise<Response>) {
  return composeRequestPipeline(
    [
      rehydrateStep,
      firstRunGateStep,
      authStep("mcp"),
      rateLimitStep({ scope: "mcp", keyFrom: "token" }),
      hydrateCredentialsStep,
    ],
    handler
  );
}

describe("transport pipeline regression (Phase 41 Task 3)", () => {
  let s: Record<string, string | undefined>;

  beforeEach(() => {
    s = snap();
    process.env.MYMCP_RATE_LIMIT_INMEMORY = "1";
    __resetFirstRunForTests();
    __resetInMemoryRateLimitForTests();
    __resetRehydrateStepForTests();
  });

  afterEach(() => {
    restore(s);
    __resetInMemoryRateLimitForTests();
  });

  it("unauthed MCP request → 401", async () => {
    process.env.MCP_AUTH_TOKEN = "real-token";
    process.env.VERCEL = "1";
    const pipeline = buildTransportPipeline(async () => new Response("never", { status: 200 }));
    const res = await pipeline(new Request("https://test.local/api/mcp", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("first-run mode (no MCP_AUTH_TOKEN) → 503 JSON with /welcome hint", async () => {
    delete process.env.MCP_AUTH_TOKEN;
    process.env.VERCEL = "1"; // suppress loopback fallthrough
    const pipeline = buildTransportPipeline(async () => new Response("never", { status: 200 }));
    const res = await pipeline(new Request("https://test.local/api/mcp", { method: "POST" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/\/welcome/);
  });

  it("valid token + rate-limit tripped → 429 with Retry-After", async () => {
    process.env.MCP_AUTH_TOKEN = "rl-token";
    process.env.MYMCP_RATE_LIMIT_ENABLED = "true";
    process.env.MYMCP_RATE_LIMIT_RPM = "2";

    const pipeline = buildTransportPipeline(async () => new Response("ok", { status: 200 }));
    const mk = () =>
      new Request("https://test.local/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer rl-token" },
      });
    const r1 = await pipeline(mk());
    const r2 = await pipeline(mk());
    const r3 = await pipeline(mk());
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get("Retry-After")).toBeTruthy();
    expect(r3.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("CORRECTNESS: per-tenant rate-limit bucket — tenant-A burst does NOT throttle tenant-B", async () => {
    process.env.MCP_AUTH_TOKEN_ACME = "acme-t";
    process.env.MYMCP_RATE_LIMIT_ENABLED = "true";
    process.env.MYMCP_RATE_LIMIT_RPM = "2";
    // Two tenants SHOULD share a token value (different tenant env vars point to the same secret in this test)
    process.env.MCP_AUTH_TOKEN = "shared-t";

    const pipeline = buildTransportPipeline(async () => new Response("ok", { status: 200 }));

    // Tenant A (header + tenant-specific env)
    process.env.MCP_AUTH_TOKEN_ACME = "shared-t";
    const mkA = () =>
      new Request("https://test.local/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer shared-t", "x-mymcp-tenant": "acme" },
      });
    const a1 = await pipeline(mkA());
    const a2 = await pipeline(mkA());
    const a3 = await pipeline(mkA());
    expect(a1.status).toBe(200);
    expect(a2.status).toBe(200);
    expect(a3.status).toBe(429);

    // Tenant B — different tenant env var, same token
    process.env.MCP_AUTH_TOKEN_BETA = "shared-t";
    const mkB = () =>
      new Request("https://test.local/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer shared-t", "x-mymcp-tenant": "beta" },
      });
    const b1 = await pipeline(mkB());
    expect(b1.status).toBe(200); // separate bucket — correctness closure
    delete process.env.MCP_AUTH_TOKEN_BETA;
  });

  it("x-request-id from header is echoed on response; handler sees it via ctx.requestId", async () => {
    process.env.MCP_AUTH_TOKEN = "ok-t";

    let seenReqId: string | null = null;
    let seenTenantId: string | null = "unset";
    const pipeline = buildTransportPipeline(async (ctx) => {
      seenReqId = ctx.requestId;
      seenTenantId = getCurrentTenantId();
      const res = new Response("ok", { status: 200 });
      res.headers.set("x-request-id", ctx.requestId);
      return res;
    });

    const res = await pipeline(
      new Request("https://test.local/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer ok-t",
          "x-request-id": "client-req-abc",
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("client-req-abc");
    expect(seenReqId).toBe("client-req-abc");
    // No tenant header → null
    expect(seenTenantId).toBeNull();
  });

  it("route.ts file references composeRequestPipeline (contract anticipation)", () => {
    const routePath = join(__dirname, "..", "..", "app", "api", "[transport]", "route.ts");
    const source = readFileSync(routePath, "utf-8");
    expect(source).toMatch(/composeRequestPipeline\(/);
    // Verify the old hand-rolled preamble is gone
    expect(source).not.toMatch(/checkMcpAuth\(/);
    expect(source).not.toMatch(/isFirstRunMode\(\)/);
  });
});
