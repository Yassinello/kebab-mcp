/**
 * 2026-11 audit, workstream B — vault safety (B2) and search quality (B3) on
 * the KV backend, against an in-memory KV.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KVStore } from "@/core/kv-store";
import {
  INDEX_CLAIM_PREFIX,
  INDEX_KEY,
  NOTE_PREFIX,
  createKvVaultBackend,
  type KvVaultBackend,
} from "../kv-backend";
import { queryTerms, stem, bestSnippet } from "../search-rank";
import { hasExtension, withMarkdownExtension } from "../paths";
import { makeMemoryKV } from "./memory-kv";

type MemKV = ReturnType<typeof makeMemoryKV>;

function indexedPaths(kv: MemKV): string[] {
  const idx = JSON.parse(kv.store.get(INDEX_KEY)!) as { notes: Record<string, unknown> };
  return Object.keys(idx.notes).sort();
}

/**
 * A view of `kv` where the first two index reads both get the index as it was
 * before either writer saved: the classic lost-update interleaving of two
 * serverless instances writing at the same moment.
 */
function interleavedIndexReads(kv: MemKV): KVStore {
  let pending: Array<() => void> = [];
  let released = false;
  return {
    ...kv,
    get: async (key: string) => {
      const value = await kv.get(key);
      if (key === INDEX_KEY && !released) {
        await new Promise<void>((resolve) => {
          pending.push(resolve);
          if (pending.length === 2) {
            released = true;
            pending.forEach((f) => f());
            pending = [];
          }
        });
      }
      return value;
    },
  };
}

describe("B2 — vault_move refuses to overwrite", () => {
  let kv: MemKV;
  let vault: KvVaultBackend;
  beforeEach(() => {
    kv = makeMemoryKV();
    vault = createKvVaultBackend(() => kv);
  });

  it("refuses when the destination exists, keeps both notes", async () => {
    await vault.write("Inbox/draft.md", "new draft");
    await vault.write("Projects/plan.md", "the real plan");
    await expect(vault.move("Inbox/draft.md", "Projects/plan.md")).rejects.toThrow(
      /already exists at Projects\/plan\.md/
    );
    expect((await vault.read("Projects/plan.md")).content).toBe("the real plan");
    expect((await vault.read("Inbox/draft.md")).content).toBe("new draft");
  });

  it("replaces the destination with overwrite: true", async () => {
    await vault.write("Inbox/draft.md", "new draft");
    await vault.write("Projects/plan.md", "old plan");
    await vault.move("Inbox/draft.md", "Projects/plan.md", { overwrite: true });
    expect((await vault.read("Projects/plan.md")).content).toBe("new draft");
    await expect(vault.read("Inbox/draft.md")).rejects.toThrow(/not found/i);
    expect(indexedPaths(kv)).toEqual(["Projects/plan.md"]);
  });

  it("reports a failed delete of the source instead of losing track of it", async () => {
    await vault.write("a.md", "a");
    const failing: KVStore = {
      ...kv,
      delete: async () => {
        throw new Error("network down");
      },
    };
    const v2 = createKvVaultBackend(() => failing);
    const res = await v2.move("a.md", "b.md");
    expect(res).toMatchObject({ from: "a.md", to: "b.md", deleteError: "network down" });
    // Both copies exist and both are indexed.
    expect(indexedPaths(kv)).toEqual(["a.md", "b.md"]);
  });
});

describe("B2 — index robust to two instances writing at once", () => {
  it("two interleaved writers on a shared store keep both entries", async () => {
    const kv = makeMemoryKV({ shared: true });
    await createKvVaultBackend(() => kv).write("seed.md", "seed");
    const view = interleavedIndexReads(kv);
    // Two instances: separate in-process locks, same store.
    const a = createKvVaultBackend(() => view);
    const b = createKvVaultBackend(() => view);
    await Promise.all([a.write("from-a.md", "A"), b.write("from-b.md", "B")]);
    expect(indexedPaths(kv)).toEqual(["from-a.md", "from-b.md", "seed.md"]);
    // Each save claimed its own revision.
    const claims = [...kv.store.keys()].filter((k) => k.startsWith(INDEX_CLAIM_PREFIX));
    expect(claims.length).toBeGreaterThanOrEqual(3);
  });

  it("without claims the second save drops an entry — self-healing reads bring it back", async () => {
    const kv = makeMemoryKV(); // no setIfNotExists, like the old behaviour
    await createKvVaultBackend(() => kv).write("seed.md", "seed");
    const view = interleavedIndexReads(kv);
    await Promise.all([
      createKvVaultBackend(() => view).write("from-a.md", "A"),
      createKvVaultBackend(() => view).write("from-b.md", "B"),
    ]);
    expect(indexedPaths(kv)).toHaveLength(2); // one entry lost
    // A fresh instance (or the periodic check) compares note keys and index
    // after the response, so the read itself never waits for the scan.
    const reader = createKvVaultBackend(() => kv);
    await reader.list();
    await vi.waitFor(() => expect(indexedPaths(kv)).toEqual(["from-a.md", "from-b.md", "seed.md"]));
    expect((await reader.list()).map((e) => e.path)).toEqual(["from-a.md", "from-b.md", "seed.md"]);
  });

  it("a claim left by a writer that died is outlived (rebuild from the notes)", async () => {
    const kv = makeMemoryKV({ shared: true });
    const vault = createKvVaultBackend(() => kv);
    await vault.write("a.md", "a");
    const rev = (JSON.parse(kv.store.get(INDEX_KEY)!) as { rev: number }).rev;
    kv.store.set(`${INDEX_CLAIM_PREFIX}${rev + 1}`, "dead writer");
    await vault.write("b.md", "b");
    expect(indexedPaths(kv)).toEqual(["a.md", "b.md"]);
    await vault.write("c.md", "c"); // and writes go on normally afterwards
    expect(indexedPaths(kv)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("verifyIndex adds missing entries and drops entries whose note is gone", async () => {
    const kv = makeMemoryKV();
    const vault = createKvVaultBackend(() => kv);
    await vault.write("a.md", "a");
    await vault.write("gone.md", "x");
    kv.store.delete(`${NOTE_PREFIX}gone.md`);
    kv.store.set(
      `${NOTE_PREFIX}lost.md`,
      JSON.stringify({
        content: "# Lost\nfound again",
        mtime: "2026-01-01T00:00:00.000Z",
        size: 18,
      })
    );
    expect(await vault.verifyIndex()).toEqual({ added: 1, removed: 1 });
    expect(indexedPaths(kv)).toEqual(["a.md", "lost.md"]);
    expect(await vault.verifyIndex()).toEqual({ added: 0, removed: 0 });
  });
});

describe("B2 — importNotes keeps differing notes unless asked", () => {
  it("reports written / kept / unchanged / overwritten", async () => {
    const kv = makeMemoryKV();
    const vault = createKvVaultBackend(() => kv);
    await vault.write("same.md", "same");
    await vault.write("edited.md", "edited locally");
    const notes = [
      { path: "same.md", content: "same" },
      { path: "edited.md", content: "from GitHub" },
      { path: "new.md", content: "new" },
    ];
    const first = await vault.importNotes(notes, "import");
    expect(first).toMatchObject({
      written: ["new.md"],
      kept: ["edited.md"],
      unchanged: ["same.md"],
      overwritten: [],
    });
    expect((await vault.read("edited.md")).content).toBe("edited locally");

    const second = await vault.importNotes(notes, "import", { overwrite: true });
    expect(second).toMatchObject({ written: [], overwritten: ["edited.md"], kept: [] });
    expect((await vault.read("edited.md")).content).toBe("from GitHub");
  });
});

describe("B3 — ranked search", () => {
  let vault: KvVaultBackend;
  beforeEach(async () => {
    const kv = makeMemoryKV();
    vault = createKvVaultBackend(() => kv);
    // The three notes of the audit, plus two for the known limits.
    await vault.write(
      "Projects/launch.md",
      "# Product launch\nWe launched the private beta in October.\n\nThe public launch is planned for 3 March."
    );
    await vault.write(
      "Notes/atelier.md",
      "# Atelier pricing\nPrepare the atelier pricing grid before Friday."
    );
    await vault.write("Notes/coffee.md", "# Coffee chat\nCoffee with the design team on Tuesday.");
    await vault.write("Notes/lancement.md", "# Lancement\nLe lancement est prévu en mars.");
    await vault.write("Notes/reunion.md", "# Réunion d'équipe\nOrdre du jour de la réunion.");
  });

  const paths = async (q: string) =>
    (await vault.search(q, { limit: 10, page: 1 })).results.map((r) => r.path);

  it('"when is the launch" finds the launch note (stopwords dropped)', async () => {
    const res = await vault.search("when is the launch", { limit: 10, page: 1 });
    expect(res.results.map((r) => r.path)).toEqual(["Projects/launch.md"]);
    expect(res.results[0]!.provenance).toBe("user");
  });

  it('"pricing workshop" finds the "atelier pricing" note through "pricing"', async () => {
    expect(await paths("pricing workshop")).toEqual(["Notes/atelier.md"]);
  });

  it('known limits: "café" does not find "coffee", "launch" does not find "lancement"', async () => {
    expect(await paths("café")).toEqual([]);
    expect(await paths("when is the launch")).not.toContain("Notes/lancement.md");
  });

  it("tolerates plurals and verb endings", async () => {
    expect(await paths("réunions")).toEqual(["Notes/reunion.md"]);
    expect(await paths("launches")).toEqual(["Projects/launch.md"]);
    expect(await paths("plan")).toEqual(["Projects/launch.md"]); // "planned"
  });

  it("ranks by matched terms (title counts double), then recency", async () => {
    await vault.write("Notes/beta.md", "Beta testers list.");
    // launch.md: "launch" in the title (2) + "beta" in the content (1).
    expect(await paths("launch beta")).toEqual(["Projects/launch.md", "Notes/beta.md"]);
  });

  it("returns the best passage of the note as the snippet", async () => {
    const res = await vault.search("public launch march", { limit: 10, page: 1 });
    expect(res.results[0]!.path).toBe("Projects/launch.md");
    expect(res.results[0]!.textMatches[0]).toBe("The public launch is planned for 3 March.");
  });

  it("a query made only of stopwords still searches its words", async () => {
    expect(queryTerms("the").map((t) => t.term)).toEqual(["the"]);
    expect(await paths("the")).toContain("Projects/launch.md");
  });
});

describe("search-rank helpers", () => {
  it("stems plurals and endings, folds accents, drops stopwords", () => {
    expect(stem("launched")).toBe("launch");
    expect(stem("reunions")).toBe(stem("reunion"));
    expect(stem("prices")).toBe(stem("pricing"));
    expect(queryTerms("Quand est le lancement ?").map((t) => t.term)).toEqual(["lancement"]);
    expect(queryTerms("Café CAFÉ cafe").map((t) => t.term)).toEqual(["cafe"]);
  });

  it("bestSnippet picks the line with the most terms", () => {
    const content = "intro line\nonly alpha here\nalpha and beta together\nend";
    expect(bestSnippet(content, queryTerms("alpha beta"))).toBe("alpha and beta together");
  });
});

describe("B1 — note paths without extension", () => {
  it("adds .md only when the last segment has no extension", () => {
    expect(withMarkdownExtension("Inbox/2026-11-15")).toEqual({
      path: "Inbox/2026-11-15.md",
      added: true,
    });
    expect(withMarkdownExtension("Notes/v2.0")).toEqual({ path: "Notes/v2.0.md", added: true });
    expect(withMarkdownExtension("a.md").added).toBe(false);
    expect(withMarkdownExtension("data.txt").added).toBe(false);
    expect(hasExtension("Folder.with.dots/note")).toBe(false);
  });

  it("KV recent and stats count a legacy note stored without extension", async () => {
    const kv = makeMemoryKV();
    const vault = createKvVaultBackend(() => kv);
    await vault.write("Inbox/2026-11-15", "legacy, written before the fix");
    await vault.write("Inbox/x.txt", "not a note");
    expect((await vault.recent(10)).map((n) => n.path)).toEqual(["Inbox/2026-11-15"]);
    expect((await vault.stats()).totalNotes).toBe(1);
  });
});

describe("index repair never blocks a read (kebab-mcp-yass, 16 Nov 2026)", () => {
  it("a scan that would take minutes does not delay list()", async () => {
    const kv = makeMemoryKV();
    await createKvVaultBackend(() => kv).write("a.md", "a");
    let stop = false;
    let pages = 0;
    // A huge keyspace: every page takes a while and the cursor never ends.
    kv.scan = async () => {
      pages++;
      await new Promise((r) => setTimeout(r, 20));
      return { cursor: stop ? "0" : String(pages), keys: [] };
    };
    const reader = createKvVaultBackend(() => kv);
    const t0 = Date.now();
    const list = await reader.list();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(list.map((e) => e.path)).toEqual(["a.md"]);
    stop = true; // end the background repair
    await vi.waitFor(() => expect(pages).toBeGreaterThan(0));
  });
});
