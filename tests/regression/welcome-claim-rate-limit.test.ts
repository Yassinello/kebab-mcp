/**
 * welcome/claim rate-limit regression — Phase 41 Task 5 / PIPE-04.
 *
 * Anti-spam gate on the first-run claim mint endpoint
 * (POST-V0.10-AUDIT §B.2 explicit closure).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { composeRequestPipeline, rateLimitStep, type PipelineContext } from "@/core/pipeline";
import { __resetInMemoryRateLimitForTests } from "@/core/rate-limit";

const ENV_KEYS = ["MYMCP_RATE_LIMIT_ENABLED", "MYMCP_RATE_LIMIT_INMEMORY", "VERCEL"];
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

describe("welcome/claim rate-limit regression (PIPE-04)", () => {
  let s: Record<string, string | undefined>;

  beforeEach(() => {
    s = snap();
    process.env.MYMCP_RATE_LIMIT_INMEMORY = "1";
    __resetInMemoryRateLimitForTests();
  });

  afterEach(() => {
    restore(s);
    __resetInMemoryRateLimitForTests();
  });

  it("route.ts exports POST via composeRequestPipeline with rateLimitStep({scope:'claim', keyFrom:'ip', limit:10})", () => {
    const source = readFileSync(resolve(process.cwd(), "app/api/welcome/claim/route.ts"), "utf-8");
    expect(source).toMatch(/composeRequestPipeline\(/);
    expect(source).toMatch(
      /rateLimitStep\(\{[^}]*scope:\s*["']claim["'][^}]*keyFrom:\s*["']ip["'][^}]*limit:\s*10/
    );
  });

  it("with rate-limit OFF (default), 50 claim requests all pass (never 429)", async () => {
    delete process.env.MYMCP_RATE_LIMIT_ENABLED;
    const step = rateLimitStep({ scope: "claim", keyFrom: "ip", limit: 10 });
    const pipeline = composeRequestPipeline(
      [step],
      async (_c: PipelineContext) => new Response("ok", { status: 200 })
    );
    for (let i = 0; i < 50; i++) {
      const res = await pipeline(new Request("https://test.local/api/welcome/claim"));
      expect(res.status).toBe(200);
    }
  });

  it("with rate-limit ON, 11th claim from the same IP is 429", async () => {
    process.env.MYMCP_RATE_LIMIT_ENABLED = "true";
    process.env.VERCEL = "1";

    const step = rateLimitStep({ scope: "claim", keyFrom: "ip", limit: 10 });
    const pipeline = composeRequestPipeline(
      [step],
      async () => new Response("ok", { status: 200 })
    );
    const headers = { "x-forwarded-for": "9.8.7.6" };
    for (let i = 0; i < 10; i++) {
      const res = await pipeline(
        new Request("https://test.local/api/welcome/claim", { method: "POST", headers })
      );
      expect(res.status).toBe(200);
    }
    const res11 = await pipeline(
      new Request("https://test.local/api/welcome/claim", { method: "POST", headers })
    );
    expect(res11.status).toBe(429);
  });
});
