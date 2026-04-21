/**
 * cron rate-limit regression — Phase 41 Task 5 / PIPE-04.
 *
 * Covers:
 *  - route.ts: composeRequestPipeline with authStep('cron') + rateLimitStep({keyFrom:'cronSecretTokenId',limit:120})
 *  - BOOTSTRAP_EXEMPT marker removed
 *  - rate-limit OFF default: no 429
 *  - rate-limit ON: 121st request is 429
 *  - webhook-alert swallow converted to log-then-swallow (no-silent-swallows)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { composeRequestPipeline, rateLimitStep, type PipelineContext } from "@/core/pipeline";
import { __resetInMemoryRateLimitForTests } from "@/core/rate-limit";

const ENV_KEYS = ["MYMCP_RATE_LIMIT_ENABLED", "MYMCP_RATE_LIMIT_INMEMORY", "CRON_SECRET"];
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

describe("cron rate-limit regression (PIPE-04)", () => {
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

  it("route.ts exports GET via composeRequestPipeline with authStep('cron') + rateLimitStep(cronSecretTokenId, 120)", () => {
    const source = readFileSync(resolve(process.cwd(), "app/api/cron/health/route.ts"), "utf-8");
    expect(source).toMatch(/composeRequestPipeline\(/);
    expect(source).toMatch(/authStep\(["']cron["']\)/);
    expect(source).toMatch(
      /rateLimitStep\(\{[^}]*scope:\s*["']cron["'][^}]*keyFrom:\s*["']cronSecretTokenId["'][^}]*limit:\s*120/
    );
    // BOOTSTRAP_EXEMPT marker removed from the first-line position
    const firstTenLines = source.split(/\r?\n/).slice(0, 10).join("\n");
    expect(firstTenLines).not.toMatch(/^\/\/\s*BOOTSTRAP_EXEMPT:/m);
    // Silent-swallow (.catch(() => {})) converted to log-then-swallow
    // by folding the historical swallow into a try/catch that logs. We
    // strip comment blocks before checking so the explanatory docstring
    // about the old shape doesn't trip the guard.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\n)\s*\/\/.*(?=\n|$)/g, "");
    expect(stripped).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\}\)/);
    expect(source).toMatch(/error-webhook\s+alert\s+failed/);
  });

  it("with rate-limit OFF (default), 200 requests all pass (never 429)", async () => {
    delete process.env.MYMCP_RATE_LIMIT_ENABLED;
    process.env.CRON_SECRET = "cron-sec";

    const step = rateLimitStep({ scope: "cron", keyFrom: "cronSecretTokenId", limit: 120 });
    const pipeline = composeRequestPipeline(
      [step],
      async (_c: PipelineContext) => new Response("ok", { status: 200 })
    );
    for (let i = 0; i < 200; i++) {
      const res = await pipeline(new Request("https://test.local/api/cron/health"));
      expect(res.status).toBe(200);
    }
  });

  it("with rate-limit ON, 121st cron request is 429 (per-CRON_SECRET bucket)", async () => {
    process.env.MYMCP_RATE_LIMIT_ENABLED = "true";
    process.env.CRON_SECRET = "cron-sec";

    const step = rateLimitStep({ scope: "cron", keyFrom: "cronSecretTokenId", limit: 120 });
    const pipeline = composeRequestPipeline(
      [step],
      async () => new Response("ok", { status: 200 })
    );
    for (let i = 0; i < 120; i++) {
      const res = await pipeline(new Request("https://test.local/api/cron/health"));
      expect(res.status).toBe(200);
    }
    const res121 = await pipeline(new Request("https://test.local/api/cron/health"));
    expect(res121.status).toBe(429);
  });
});
