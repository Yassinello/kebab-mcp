/** REL-09 (2026-11 audit): UpstashKV.list iterates SCAN, never KEYS. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getKVStore, resetKVStoreCache } from "@/core/kv-store";

describe("UpstashKV.list", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetKVStoreCache();
  });

  it("pages through SCAN with MATCH and never issues KEYS", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://kv.example.com");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t");
    resetKVStoreCache();
    const commands: unknown[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const cmd = JSON.parse(String(init.body)) as unknown[];
        commands.push(cmd);
        expect(init.signal).toBeDefined();
        const cursor = String(cmd[1]);
        const result = cursor === "0" ? ["7", ["tool:disabled:a"]] : ["0", ["tool:disabled:b"]];
        return new Response(JSON.stringify({ result }), { status: 200 });
      })
    );
    const kv = getKVStore();
    const keys = await kv.list("tool:disabled:");
    expect(keys.sort()).toEqual(["tool:disabled:a", "tool:disabled:b"]);
    expect(commands.every((c) => c[0] === "SCAN")).toBe(true);
    expect(commands[0]).toContain("tool:disabled:*");
  });
});
