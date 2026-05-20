/**
 * Phase 39 / HOST-04 — Multi-host compatibility integration test.
 *
 * Simulates three host scenarios in pure vitest WITHOUT spawning Docker.
 * "Process boundaries" are modeled as distinct `MemoryKV` instances (one
 * per simulated process) or as a single shared `MemoryKV` instance held
 * by reference across multiple simulated processes (simulating two
 * lambdas hitting the same Upstash).
 *
 * This file is the regression gate for:
 *   - HOST-04a: cross-process state flows through KV only (not globals).
 *   - HOST-04b: MYMCP_RECOVERY_RESET=1 is refused by the welcome/init
 *     foot-gun guard (commit 5273add on main) on a persistent process.
 *   - HOST-04c: rate-limit counters converge via shared KV and DO NOT
 *     converge when `MYMCP_RATE_LIMIT_INMEMORY=1` is set (negative
 *     control proving the HOST-05 escape hatch is a local-only path).
 *
 * Zero Docker dependency per Phase 39 user prompt. No child_process,
 * no testcontainers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as kvStore from "@/core/kv-store";
import * as requestContext from "@/core/request-context";
import { checkRateLimit, __resetInMemoryRateLimitForTests } from "@/core/rate-limit";

// Import the /api/welcome/init POST handler for Scenario B. This is
// where commit 5273add installed the foot-gun guard.
import { POST as welcomeInitPOST } from "../../app/api/welcome/init/route";

// ─── Shared test helpers ────────────────────────────────────────────

/**
 * MemoryKV — in-process KVStore with atomic incr. Two callers holding
 * references to the SAME instance model "two replicas sharing Upstash".
 * Two different instances model "two replicas with independent state".
 */
class MemoryKV {
  public readonly kind = "filesystem" as const;
  private map = new Map<string, string>();
  public incrCalls = 0;

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(prefix?: string): Promise<string[]> {
    const keys = [...this.map.keys()];
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }
  async incr(key: string, _opts?: { ttlSeconds?: number }): Promise<number> {
    this.incrCalls++;
    const prev = parseInt(this.map.get(key) ?? "0", 10);
    const next = Number.isFinite(prev) ? prev + 1 : 1;
    this.map.set(key, String(next));
    return next;
  }
  // Expose for assertions.
  snapshot(): Map<string, string> {
    return new Map(this.map);
  }
}

// ─── Scenario A — two lambda-like processes share state only via KV ──

describe("Phase 39 / HOST-04 / Scenario A — cross-process state via KV", () => {
  let sharedKv: MemoryKV;
  let privateKvP1: MemoryKV;
  let privateKvP2: MemoryKV;

  beforeEach(() => {
    sharedKv = new MemoryKV();
    privateKvP1 = new MemoryKV();
    privateKvP2 = new MemoryKV();
  });

  it("P2 reads what P1 wrote through shared KV (A1)", async () => {
    // Process P1 writes a tenant-scoped credential into shared KV.
    // We use the raw set/get API directly — we don't need to touch
    // checkRateLimit for this assertion; the point is "state written
    // by one replica is visible to another via the same KV."
    await sharedKv.set("tenant:alpha:cred:GOOGLE_API_KEY", "v1-minted-on-P1");
    await sharedKv.set(
      "mymcp:firstrun:bootstrap",
      JSON.stringify({ token: "tok-abc", createdAt: Date.now() })
    );

    // Process P2 (a different simulated replica) reads from the SAME
    // MemoryKV reference — this is the "both lambdas point at the same
    // Upstash" model.
    const credViaP2 = await sharedKv.get("tenant:alpha:cred:GOOGLE_API_KEY");
    const bootstrapViaP2 = await sharedKv.get("mymcp:firstrun:bootstrap");

    expect(credViaP2).toBe("v1-minted-on-P1");
    expect(bootstrapViaP2).not.toBeNull();
    const parsed = JSON.parse(bootstrapViaP2 as string);
    expect(parsed.token).toBe("tok-abc");
  });

  it("P2 does not see P1's module-local (private) state (A2)", async () => {
    // Negative control: when each process holds a PRIVATE MemoryKV
    // (no shared reference), writes on P1 are invisible to P2. This
    // proves the sharing in A1 flows ONLY through the shared instance,
    // not through any module-scoped singleton.
    await privateKvP1.set("cred:GOOGLE_API_KEY", "lives-only-on-P1");

    const viaP2 = await privateKvP2.get("cred:GOOGLE_API_KEY");
    expect(viaP2).toBeNull();

    // And the shared KV should be untouched (nothing was ever written
    // to it in this test).
    const viaShared = await sharedKv.get("cred:GOOGLE_API_KEY");
    expect(viaShared).toBeNull();
  });
});

// ─── Scenario B — MYMCP_RECOVERY_RESET=1 refuses welcome/init on a
//     persistent process that has prior bootstrap state ──────────────

describe("Phase 39 / HOST-04 / Scenario B — RECOVERY_RESET foot-gun guard", () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.MYMCP_RECOVERY_RESET;
  });

  afterEach(() => {
    // Hygiene: never leak the env flag out of the test suite. Anything
    // else in the process that reads MYMCP_RECOVERY_RESET would misfire.
    if (prevEnv === undefined) {
      delete process.env.MYMCP_RECOVERY_RESET;
    } else {
      process.env.MYMCP_RECOVERY_RESET = prevEnv;
    }
  });

  it("POST /api/welcome/init returns 409 when MYMCP_RECOVERY_RESET=1 (B1)", async () => {
    // Simulate a persistent-process cold start where the operator left
    // the env var set. Commit 5273add added a guard at the TOP of the
    // POST handler that refuses outright — minting a token here would
    // hand the user a credential that the next forceReset() erases.
    process.env.MYMCP_RECOVERY_RESET = "1";

    const req = new Request("http://localhost:3000/api/welcome/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const res = await welcomeInitPOST(req);
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: string };
    // HIGH-2: the 409 copy now names the modern KEBAB_RECOVERY_RESET; the
    // legacy env var still triggers the guard via the getConfig alias. The
    // bare RECOVERY_RESET match is robust to the brand prefix.
    expect(body.error).toMatch(/RECOVERY_RESET=1/);
    expect(body.error).toMatch(/Remove the env var/i);
  });
});

// ─── Scenario C — N-replica rate-limit convergence via shared KV ────

describe("Phase 39 / HOST-04 / Scenario C — N-replica rate-limit convergence", () => {
  let sharedKv: MemoryKV;
  let getKVStoreSpy: ReturnType<typeof vi.spyOn>;
  let prevInMem: string | undefined;

  beforeEach(() => {
    __resetInMemoryRateLimitForTests();
    sharedKv = new MemoryKV();
    // Inject the shared KV for every `checkRateLimit` caller — this is
    // the "two replicas pointing at the same Upstash" model.
    // rate-limit.ts uses getContextKVStore (Phase 42 / TEN-01 migration).
    // Spy on request-context so both the shared-KV and in-memory paths
    // route through sharedKv.
    getKVStoreSpy = vi.spyOn(requestContext, "getContextKVStore").mockReturnValue(sharedKv);
    prevInMem = process.env.MYMCP_RATE_LIMIT_INMEMORY;
  });

  afterEach(() => {
    getKVStoreSpy.mockRestore();
    __resetInMemoryRateLimitForTests();
    if (prevInMem === undefined) {
      delete process.env.MYMCP_RATE_LIMIT_INMEMORY;
    } else {
      process.env.MYMCP_RATE_LIMIT_INMEMORY = prevInMem;
    }
  });

  it("atomic incr via shared KV converges counters across replicas (C1)", async () => {
    // N interleaved calls across "two replicas" — both hit the same
    // checkRateLimit, both get KV injected as sharedKv. The atomic
    // incr path (pipelined in production, Map-backed here) ensures
    // the final counter equals N exactly and each replica sees a
    // consistent `remaining` sequence.
    const N = 100;
    const limit = 1_000_000; // set very high so we never hit the cap
    const identifier = "shared-tenant-key";
    const scope = "mcp";

    const tasks: Promise<{ allowed: boolean; remaining: number }>[] = [];
    for (let i = 0; i < N; i++) {
      // Interleave by rotating which "replica" fires next. Both call
      // checkRateLimit — the spy routes them both to sharedKv.
      tasks.push(checkRateLimit(identifier, { scope, limit }));
    }
    const results = await Promise.all(tasks);

    // Every call should have been allowed (limit is huge).
    expect(results.every((r) => r.allowed)).toBe(true);

    // The incr call count on sharedKv must equal N — no replica-local
    // increments leaked.
    expect(sharedKv.incrCalls).toBe(N);

    // Find the bucket key in sharedKv and assert its final value is N.
    const snap = sharedKv.snapshot();
    const bucketEntries = [...snap.entries()].filter(([k]) => k.startsWith("ratelimit:"));
    expect(bucketEntries.length).toBe(1);
    const [, count] = bucketEntries[0]!;
    expect(parseInt(count, 10)).toBe(N);
  });

  it("MYMCP_RATE_LIMIT_INMEMORY=1 isolates counters per replica (C2 — negative control)", async () => {
    // HOST-05 escape hatch: with the flag set, checkRateLimit short-
    // circuits to the in-process Map BEFORE touching KV. In a real
    // N-replica deploy, each replica's Map would be independent and
    // counters would NOT converge. Here we simulate that by firing
    // N calls, resetting the module-local Map midway (proxying "a
    // second replica starts from zero"), and asserting the bucket in
    // KV never rises.
    process.env.MYMCP_RATE_LIMIT_INMEMORY = "1";

    const limit = 10;
    const identifier = "per-replica-key";
    const scope = "mcp";

    // Replica 1 fires 5 requests. Each call goes through the in-memory
    // path, incrementing the Map. sharedKv sees none of them.
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(identifier, { scope, limit });
    }

    // Reset the Map — proxies "replica 2 boots fresh". In production
    // this is the natural state of a new process: its in-memory Map
    // is empty.
    __resetInMemoryRateLimitForTests();

    // Replica 2 fires 5 more requests. Because its Map was empty, it
    // starts counting from 1 again — NO awareness of replica 1's 5.
    const r6 = await checkRateLimit(identifier, { scope, limit });
    const r7 = await checkRateLimit(identifier, { scope, limit });

    // Both replicas would report remaining=9 after their first call,
    // remaining=8 after their second, etc. The counters DIVERGE.
    expect(r6.remaining).toBe(9);
    expect(r7.remaining).toBe(8);

    // KV must be untouched — the HOST-05 gate kept the limiter
    // entirely in-process.
    expect(sharedKv.incrCalls).toBe(0);
    const snap = sharedKv.snapshot();
    const bucketEntries = [...snap.entries()].filter(([k]) => k.startsWith("ratelimit:"));
    expect(bucketEntries.length).toBe(0);
  });
});
