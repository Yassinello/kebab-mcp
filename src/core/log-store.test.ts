import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryLogStore, FilesystemLogStore, type LogEntry } from "./log-store";

function mk(ts: number, message: string, level: LogEntry["level"] = "info"): LogEntry {
  return { ts, level, message };
}

describe("MemoryLogStore", () => {
  it("stores entries and returns them newest-first", async () => {
    const store = new MemoryLogStore(10);
    await store.append(mk(1, "a"));
    await store.append(mk(2, "b"));
    await store.append(mk(3, "c"));
    const recent = await store.recent(10);
    expect(recent.map((e) => e.message)).toEqual(["c", "b", "a"]);
  });

  it("caps at maxEntries (FIFO eviction)", async () => {
    const store = new MemoryLogStore(3);
    for (let i = 1; i <= 5; i++) await store.append(mk(i, String(i)));
    const recent = await store.recent(10);
    expect(recent.map((e) => e.message)).toEqual(["5", "4", "3"]);
  });

  it("since() filters by timestamp and returns newest-first", async () => {
    const store = new MemoryLogStore(10);
    await store.append(mk(10, "old"));
    await store.append(mk(20, "mid"));
    await store.append(mk(30, "new"));
    const after = await store.since(20);
    expect(after.map((e) => e.message)).toEqual(["new", "mid"]);
  });

  it("recent(n) respects the requested count", async () => {
    const store = new MemoryLogStore(10);
    for (let i = 0; i < 5; i++) await store.append(mk(i, String(i)));
    const two = await store.recent(2);
    expect(two.map((e) => e.message)).toEqual(["4", "3"]);
  });
});

describe("FilesystemLogStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mymcp-log-"));
    filePath = join(dir, "logs.jsonl");
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("JSON roundtrips entries through the file", async () => {
    const store = new FilesystemLogStore(filePath);
    const entry: LogEntry = {
      ts: 123,
      level: "error",
      message: "boom",
      meta: { tool: "foo", durationMs: 42 },
    };
    await store.append(entry);
    const recent = await store.recent(5);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toEqual(entry);
  });

  it("appends and returns entries newest-first", async () => {
    const store = new FilesystemLogStore(filePath);
    for (let i = 1; i <= 4; i++) await store.append(mk(i, String(i)));
    const recent = await store.recent(10);
    expect(recent.map((e) => e.message)).toEqual(["4", "3", "2", "1"]);
  });

  it("rotates at maxBytes and still reads both segments", async () => {
    const store = new FilesystemLogStore(filePath, { maxBytes: 200, maxEntries: 100 });
    // Each entry is ~40 bytes; 10 entries overflow the 200-byte cap.
    for (let i = 0; i < 10; i++) {
      await store.append(mk(i, "x".repeat(10) + i));
    }
    const recent = await store.recent(20);
    // All entries should still be readable (current + rotated segment).
    expect(recent).toHaveLength(10);
    expect(recent[0].message).toBe("xxxxxxxxxx9");
    expect(recent[recent.length - 1].message).toBe("xxxxxxxxxx0");
  });

  it("honors maxEntries cap when concatenating segments", async () => {
    const store = new FilesystemLogStore(filePath, { maxBytes: 100, maxEntries: 5 });
    for (let i = 0; i < 15; i++) await store.append(mk(i, String(i)));
    const recent = await store.recent(100);
    expect(recent.length).toBeLessThanOrEqual(5);
  });

  it("since() filters by ts across rotated + current", async () => {
    const store = new FilesystemLogStore(filePath, { maxBytes: 150, maxEntries: 100 });
    for (let i = 0; i < 8; i++) await store.append(mk(i * 10, `m${i}`));
    const since = await store.since(50);
    expect(since.map((e) => e.message)).toEqual(["m7", "m6", "m5"]);
  });

  it("skips malformed JSON lines without crashing", async () => {
    const store = new FilesystemLogStore(filePath);
    await store.append(mk(1, "ok"));
    // Inject garbage directly.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(filePath, "not-json\n", "utf-8");
    await store.append(mk(2, "still-ok"));
    const recent = await store.recent(10);
    expect(recent.map((e) => e.message)).toEqual(["still-ok", "ok"]);
  });
});
