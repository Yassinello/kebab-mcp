/**
 * B4 (2026-11 audit) — filesystem KV: TTLs are honoured and ephemeral writes
 * (counters, TTL'd keys) are coalesced instead of rewriting the whole file on
 * every call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getKVStore, resetKVStoreCache, flushKVWrites, clearKVReadCache } from "./kv-store";

let tmpDir: string;
let kvPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kv-ttl-test-"));
  kvPath = path.join(tmpDir, "kv.json");
  process.env.MYMCP_KV_PATH = kvPath;
  resetKVStoreCache();
});

afterEach(async () => {
  vi.useRealTimers();
  resetKVStoreCache();
  delete process.env.MYMCP_KV_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function readFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(kvPath, "utf-8")) as Record<string, unknown>;
}

describe("FilesystemKV TTL", () => {
  it("an expired key reads as absent (get, mget, list, scan)", async () => {
    const kv = getKVStore();
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    await kv.set("oauth:at:x", "token", 60);
    await kv.set("keep", "forever");
    expect(await kv.get("oauth:at:x")).toBe("token");

    spy.mockReturnValue(now + 61_000);
    expect(await kv.get("oauth:at:x")).toBeNull();
    expect(await kv.mget!(["oauth:at:x", "keep"])).toEqual([null, "forever"]);
    expect(await kv.list("oauth:")).toEqual([]);
    expect((await kv.scan!("0", { match: "oauth:*" })).keys).toEqual([]);
    expect(await kv.get("keep")).toBe("forever");
    spy.mockRestore();
  });

  it("expired keys are swept from the file on a later write", async () => {
    const kv = getKVStore();
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    await kv.set("approval:preview:1", "full message text", 30);
    await flushKVWrites();
    expect(Object.keys(await readFile())).toContain("approval:preview:1");

    spy.mockReturnValue(now + 120_000);
    await kv.set("settings:locale", "fr-FR"); // durable write → sweep
    const onDisk = await readFile();
    expect(onDisk).not.toHaveProperty("approval:preview:1");
    expect(onDisk["settings:locale"]).toBe("fr-FR");
    spy.mockRestore();
  });

  it("setIfNotExists treats an expired key as absent", async () => {
    const kv = getKVStore();
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    expect(await kv.setIfNotExists!("lock", "a", { ttlSeconds: 10 })).toEqual({ ok: true });
    expect(await kv.setIfNotExists!("lock", "b", { ttlSeconds: 10 })).toEqual({
      ok: false,
      existing: "a",
    });
    spy.mockReturnValue(now + 11_000);
    expect(await kv.setIfNotExists!("lock", "c", { ttlSeconds: 10 })).toEqual({ ok: true });
    expect(await kv.get("lock")).toBe("c");
    spy.mockRestore();
  });

  it("incr restarts an expired counter and set without TTL clears the expiry", async () => {
    const kv = getKVStore();
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    expect(await kv.incr!("usage:x", { ttlSeconds: 5 })).toBe(1);
    expect(await kv.incr!("usage:x")).toBe(2); // keeps its expiry
    spy.mockReturnValue(now + 6_000);
    expect(await kv.incr!("usage:x", { ttlSeconds: 5 })).toBe(1);

    await kv.set("k", "v", 5);
    await kv.set("k", "v2"); // no TTL → permanent
    spy.mockReturnValue(now + 60_000);
    expect(await kv.get("k")).toBe("v2");
    spy.mockRestore();
  });

  it("loads files written by older versions (plain string values)", async () => {
    await fs.writeFile(kvPath, JSON.stringify({ "skills:all": "[]", a: "1" }, null, 2));
    const kv = getKVStore();
    expect(await kv.get("skills:all")).toBe("[]");
    await kv.set("b", "2");
    const onDisk = await readFile();
    expect(onDisk).toEqual({ "skills:all": "[]", a: "1", b: "2" });
  });

  it("TTL'd values persist across a restart until they expire", async () => {
    const kv = getKVStore();
    await kv.set("devices:invite:n", "x", 3600);
    resetKVStoreCache(); // flushes pending writes
    const kv2 = getKVStore();
    expect(await kv2.get("devices:invite:n")).toBe("x");
  });
});

describe("FilesystemKV write coalescing", () => {
  it("many incr calls on a large store stay fast, and land on disk", async () => {
    // ~8 MB of notes, like a well-filled vault on the Docker path.
    const big: Record<string, string> = {};
    const body = "x".repeat(8 * 1024);
    for (let i = 0; i < 1000; i++) big[`vault:note:n${i}.md`] = body;
    await fs.writeFile(kvPath, JSON.stringify(big));
    const kv = getKVStore();
    await kv.get("warm-up");

    const started = Date.now();
    for (let i = 0; i < 50; i++) await kv.incr!("usage:calls", { ttlSeconds: 3600 });
    const elapsed = Date.now() - started;
    // Before: one full-file rewrite per call (~130 ms each for 15 MB).
    expect(elapsed).toBeLessThan(500);
    expect(await kv.get("usage:calls")).toBe("50");

    await flushKVWrites();
    const onDisk = await readFile();
    expect(onDisk["usage:calls"]).toMatchObject({ v: "50" });
    expect(onDisk["vault:note:n999.md"]).toBe(body);
  });

  it("deferred writes reach the disk on their own shortly after", async () => {
    const kv = getKVStore();
    await kv.incr!("ratelimit:a:1");
    await vi.waitFor(
      async () => {
        const onDisk = await readFile();
        expect(onDisk["ratelimit:a:1"]).toBe("1");
      },
      { timeout: 2000, interval: 50 }
    );
  });

  it("durable writes are on disk when set() resolves; concurrent ones share writes", async () => {
    const kv = getKVStore();
    const spy = vi.spyOn(fs, "rename");
    await Promise.all(Array.from({ length: 20 }, (_, i) => kv.set(`k${i}`, String(i))));
    const onDisk = await readFile();
    for (let i = 0; i < 20; i++) expect(onDisk[`k${i}`]).toBe(String(i));
    expect(spy.mock.calls.length).toBeLessThan(20);
    spy.mockRestore();
  });

  it("picks up a change made to the file by another process", async () => {
    const kv = getKVStore();
    await kv.set("a", "1");
    // Another process rewrites the file (different size → detected).
    await fs.writeFile(kvPath, JSON.stringify({ a: "1", b: "from-elsewhere" }));
    expect(await kv.get("b")).toBe("from-elsewhere");
  });

  it("clearKVReadCache never drops pending writes", async () => {
    const kv = getKVStore();
    await kv.incr!("usage:y");
    clearKVReadCache();
    expect(await kv.get("usage:y")).toBe("1");
  });
});
