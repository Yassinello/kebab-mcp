/**
 * VLT-03 / VLT-05 (Kebab House phase 2): the KV vault backend, against an
 * in-memory KV (with and without scan/mget).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  INDEX_KEY,
  KV_VAULT_LIMITS,
  NOTE_PREFIX,
  blobSha,
  createKvVaultBackend,
  extractLinks,
  foldText,
  type KvVaultBackend,
} from "../kv-backend";
import { VaultConflictError, VaultLimitError, VaultNotFoundError } from "@/core/connector-errors";
import { makeMemoryKV } from "./memory-kv";

type MemKV = ReturnType<typeof makeMemoryKV>;

let kv: MemKV;
let vault: KvVaultBackend;

beforeEach(() => {
  kv = makeMemoryKV();
  vault = createKvVaultBackend(() => kv);
});

function index(): { v: 1; notes: Record<string, { title: string; links: string[] }> } {
  return JSON.parse(kv.store.get(INDEX_KEY)!);
}

describe("CRUD", () => {
  it("creates, reads, updates and deletes a note", async () => {
    const w = await vault.write("Notes/a.md", "# Alpha\nhello");
    expect(w).toMatchObject({ path: "Notes/a.md", created: true });
    expect(w.sha).toBe(blobSha("# Alpha\nhello"));

    const r = await vault.read("Notes/a.md");
    expect(r).toEqual({
      path: "Notes/a.md",
      name: "a.md",
      sha: w.sha,
      content: "# Alpha\nhello",
      size: 13,
    });

    const u = await vault.write("Notes/a.md", "# Alpha\nbye");
    expect(u.created).toBe(false);
    expect((await vault.read("Notes/a.md")).content).toBe("# Alpha\nbye");

    expect(await vault.delete("Notes/a.md")).toEqual({ path: "Notes/a.md" });
    await expect(vault.read("Notes/a.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    await expect(vault.delete("Notes/a.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    expect(index().notes).toEqual({});
  });

  it("stores one key per note with content, mtime and size", async () => {
    await vault.write("x.md", "été", { message: "first line\nsecond" });
    const stored = JSON.parse(kv.store.get(`${NOTE_PREFIX}x.md`)!);
    expect(stored.content).toBe("été");
    expect(stored.size).toBe(5); // bytes, not characters
    expect(Date.parse(stored.mtime)).not.toBeNaN();
    expect(stored.message).toBe("first line");
  });

  it("uses the git blob SHA as version (same as GitHub)", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(blobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(blobSha("x")).toBe(createHash("sha1").update("blob 1\0x").digest("hex"));
  });

  it("optimistic concurrency: refuses a write or delete with a stale version", async () => {
    const first = await vault.write("n.md", "v1");
    await vault.write("n.md", "v2", { expectedVersion: first.sha });
    await expect(vault.write("n.md", "v3", { expectedVersion: first.sha })).rejects.toBeInstanceOf(
      VaultConflictError
    );
    await expect(vault.delete("n.md", { expectedVersion: first.sha })).rejects.toBeInstanceOf(
      VaultConflictError
    );
    // Expected version on a note that does not exist (deleted meanwhile).
    await expect(
      vault.write("gone.md", "x", { expectedVersion: first.sha })
    ).rejects.toBeInstanceOf(VaultConflictError);
    expect((await vault.read("n.md")).content).toBe("v2");
  });
});

describe("move", () => {
  it("moves a note and updates the index in one step", async () => {
    await vault.write("Inbox/n.md", "# N\n[[other]]");
    expect(await vault.move("Inbox/n.md", "Done/n.md", { message: "file it" })).toEqual({
      from: "Inbox/n.md",
      to: "Done/n.md",
    });
    await expect(vault.read("Inbox/n.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    expect((await vault.read("Done/n.md")).content).toBe("# N\n[[other]]");
    expect(Object.keys(index().notes)).toEqual(["Done/n.md"]);
    expect((await vault.recent(5))[0]).toMatchObject({ path: "Done/n.md", message: "file it" });
  });

  it("refuses a missing source, the same path and plumbing destinations", async () => {
    await expect(vault.move("nope.md", "x.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    await vault.write("a.md", "a");
    await expect(vault.move("a.md", "a.md")).rejects.toThrow(/same path/);
    await expect(vault.move("a.md", ".github/workflows/x.yml")).rejects.toThrow(/not allowed/);
    expect((await vault.read("a.md")).content).toBe("a");
  });
});

describe("list / tree", () => {
  beforeEach(async () => {
    await vault.write("root.md", "r");
    await vault.write("Projects/a.md", "aa");
    await vault.write("Projects/sub/b.md", "bbb");
    await vault.write("Journal/2026-11-13.md", "j");
  });

  it("lists direct children (folders and notes), sorted by name", async () => {
    expect(await vault.list()).toEqual([
      { name: "Journal", path: "Journal", type: "dir", size: 0 },
      { name: "Projects", path: "Projects", type: "dir", size: 0 },
      { name: "root.md", path: "root.md", type: "file", size: 1 },
    ]);
    const projects = await vault.list("Projects/");
    expect(projects).toEqual([
      { name: "a.md", path: "Projects/a.md", type: "file", size: 2 },
      { name: "sub", path: "Projects/sub", type: "dir", size: 0 },
    ]);
  });

  it("reports unknown folders and files passed as folders", async () => {
    await expect(vault.list("Nope")).rejects.toBeInstanceOf(VaultNotFoundError);
    await expect(vault.list("root.md")).rejects.toThrow(/is a file/);
    await expect(vault.list("../x")).rejects.toThrow(/traversal/);
  });

  it("tree is recursive and folder-scoped", async () => {
    expect((await vault.tree()).map((f) => f.path)).toEqual([
      "Journal/2026-11-13.md",
      "Projects/a.md",
      "Projects/sub/b.md",
      "root.md",
    ]);
    const sub = await vault.tree("Projects");
    expect(sub).toEqual([
      { path: "Projects/a.md", size: 2, sha: blobSha("aa") },
      { path: "Projects/sub/b.md", size: 3, sha: blobSha("bbb") },
    ]);
  });
});

describe("search", () => {
  beforeEach(async () => {
    await vault.write("Notes/ete.md", "---\ntitle: Résumé de l'Été\n---\nUn texte.");
    await vault.write("Notes/other.md", "Nothing about summer here.");
    await vault.write(
      "Veille/article.md",
      "---\nprovenance: external\n---\nLong intro. Ce RÉSUMÉ parle de café et de crème brûlée."
    );
    await vault.write("Notes/decomposed.md", "Café au lait"); // e + combining acute
  });

  it("matches titles first, then contents, accent- and case-insensitively", async () => {
    const res = await vault.search("resume", { limit: 10, page: 1 });
    expect(res.method).toBe("kv_index");
    expect(res.results.map((r) => r.path)).toEqual(["Notes/ete.md", "Veille/article.md"]);
    expect(res.results[0]!.textMatches[0]).toMatch(/^Title match: Résumé/);
    expect(res.results[1]!.textMatches[0]).toContain("RÉSUMÉ");
    expect(res.totalCount).toBe(2);
  });

  it("matches accented content from an unaccented query and vice versa", async () => {
    expect((await vault.search("cafe", { limit: 10, page: 1 })).results.map((r) => r.path)).toEqual(
      expect.arrayContaining(["Veille/article.md", "Notes/decomposed.md"])
    );
    const r = await vault.search("CRÈME brulee", { limit: 10, page: 1 });
    expect(r.results.map((x) => x.path)).toEqual(["Veille/article.md"]);
    expect(r.results[0]!.textMatches[0]).toContain("crème");
  });

  it("carries provenance from the index (no extra read needed)", async () => {
    const r = await vault.search("cafe", { limit: 10, page: 1 });
    const art = r.results.find((x) => x.path === "Veille/article.md");
    expect(art?.provenance).toBe("external");
    const dec = r.results.find((x) => x.path === "Notes/decomposed.md");
    expect(dec?.provenance).toBe("user");
  });

  it("filters by folder, paginates and refuses empty queries", async () => {
    expect(
      (await vault.search("cafe", { folder: "Veille/", limit: 10, page: 1 })).results.map(
        (r) => r.path
      )
    ).toEqual(["Veille/article.md"]);
    const p2 = await vault.search("cafe", { limit: 1, page: 2 });
    expect(p2.totalCount).toBe(2);
    expect(p2.results).toHaveLength(1);
    await expect(vault.search("   ", { limit: 10, page: 1 })).rejects.toThrow(/empty/);
  });

  it("folds accents and case", () => {
    expect(foldText("Ça Été ÉLÈVE")).toBe("ca ete eleve");
  });
});

describe("recent", () => {
  it("orders by modification date, newest first, with folder and since filters", async () => {
    await vault.write("a.md", "a", { message: "A" });
    await new Promise((r) => setTimeout(r, 5));
    await vault.write("Journal/b.md", "b", { message: "B" });
    await new Promise((r) => setTimeout(r, 5));
    await vault.write("c.md", "c");
    await vault.write("not-markdown.txt", "t");

    const all = await vault.recent(10);
    expect(all.map((n) => n.path)).toEqual(["c.md", "Journal/b.md", "a.md"]);
    expect(all[0]).toMatchObject({ message: "Update via Kebab MCP", author: "Kebab House" });
    expect(all[1]!.message).toBe("B");
    expect((await vault.recent(1)).map((n) => n.path)).toEqual(["c.md"]);
    expect((await vault.recent(10, { folder: "Journal/" })).map((n) => n.path)).toEqual([
      "Journal/b.md",
    ]);
    expect(await vault.recent(10, { since: "2999-01-01" })).toEqual([]);
    expect((await vault.recent(10, { since: "2000-01-01" })).length).toBe(3);
    await expect(vault.recent(10, { since: "not a date" })).rejects.toThrow(/Invalid/);
  });
});

describe("links, due, stats", () => {
  it("indexes outgoing links and answers link candidates", async () => {
    expect(extractLinks("see [[Target]], [[Projects/Target|alias]] and [[Other#h2]]")).toEqual([
      "Target",
      "Projects/Target",
      "Other",
    ]);
    await vault.write("Projects/Target.md", "# T");
    await vault.write("a.md", "links [[Target]]");
    await vault.write("b.md", "links [[Projects/Target|t]]");
    await vault.write("c.md", "no link");
    expect(await vault.linkCandidates!("Projects/Target.md")).toEqual(["a.md", "b.md"]);
  });

  it("flags notes with a resurface field", async () => {
    await vault.write("due.md", "---\nresurface: 2020-01-01\n---\nx");
    await vault.write("Sub/later.md", "---\nresurface: when_relevant\n---\ny");
    await vault.write("plain.md", "---\ntitle: z\n---\nz");
    expect(await vault.dueCandidates!()).toEqual(["Sub/later.md", "due.md"]);
    expect(await vault.dueCandidates!("Sub")).toEqual(["Sub/later.md"]);
  });

  it("stats count markdown notes per folder", async () => {
    await vault.write("a.md", "aaaa");
    await vault.write("Inbox/b.md", "bb");
    await vault.write("Inbox/c.txt", "c");
    expect(await vault.stats()).toEqual({
      totalNotes: 2,
      totalSize: 6,
      folderCounts: { "(root)": 1, Inbox: 1 },
    });
  });
});

describe("limits", () => {
  it("refuses notes over 256 KB", async () => {
    const big = "x".repeat(KV_VAULT_LIMITS.maxNoteBytes + 1);
    await expect(vault.write("big.md", big)).rejects.toBeInstanceOf(VaultLimitError);
    // Multi-byte characters count in bytes.
    const accents = "é".repeat(KV_VAULT_LIMITS.maxNoteBytes / 2 + 1);
    await expect(vault.write("accents.md", accents)).rejects.toThrow(/too large/);
    await expect(
      vault.write("ok.md", "x".repeat(KV_VAULT_LIMITS.maxNoteBytes))
    ).resolves.toMatchObject({ created: true });
  });

  it("refuses a new note beyond 5000 notes, but still updates existing ones", async () => {
    const notes: Record<string, unknown> = {};
    for (let i = 0; i < KV_VAULT_LIMITS.maxNotes; i++) {
      notes[`n${i}.md`] = {
        title: "t",
        mtime: "2026-01-01T00:00:00.000Z",
        size: 1,
        sha: "s",
        links: [],
      };
    }
    kv.store.set(INDEX_KEY, JSON.stringify({ v: 1, notes }));
    kv.store.set(
      `${NOTE_PREFIX}n1.md`,
      JSON.stringify({ content: "x", mtime: "2026-01-01T00:00:00.000Z", size: 1 })
    );
    await expect(vault.write("new.md", "x")).rejects.toThrow(/full/);
    await expect(vault.write("n1.md", "updated")).resolves.toMatchObject({ created: false });
  });

  it("warns above 50 MB in total", async () => {
    const notes: Record<string, unknown> = {};
    for (let i = 0; i < 210; i++) {
      notes[`n${i}.md`] = {
        title: "t",
        mtime: "2026-01-01T00:00:00.000Z",
        size: 250 * 1024,
        sha: "s",
        links: [],
      };
    }
    kv.store.set(INDEX_KEY, JSON.stringify({ v: 1, notes }));
    const w = await vault.write("one-more.md", "x");
    expect(w.warning).toMatch(/50 MB/);
    expect((await vault.stats()).warning).toMatch(/50 MB/);
  });
});

describe("path validation (identical to the GitHub backend)", () => {
  it.each([
    ["", /empty/],
    ["../etc/passwd", /traversal/],
    ["a/../b.md", /traversal/],
    ["/abs.md", /relative/],
    ["nul\0.md", /null/],
    [".github/workflows/pwn.yml", /not allowed/],
    [".GitHub/x.md", /not allowed/],
    [".gitignore", /not allowed/],
    [".git/config", /not allowed/],
  ])("refuses to write %j", async (path, re) => {
    await expect(vault.write(path, "x")).rejects.toThrow(re);
    await expect(vault.delete(path)).rejects.toThrow(re);
  });

  it("refuses traversal on reads and listings too, and folder-like note paths", async () => {
    await expect(vault.read("../x.md")).rejects.toThrow(/traversal/);
    await expect(vault.tree("../x")).rejects.toThrow(/traversal/);
    await expect(vault.write("Folder/", "x")).rejects.toThrow(/folder/);
    await expect(vault.write("github-notes.md", "ok")).resolves.toMatchObject({ created: true });
  });
});

describe("index recovery", () => {
  it("rebuilds the index from the notes when it is missing or corrupt", async () => {
    await vault.write("a.md", "# A\n[[b]]");
    await vault.write("Sub/b.md", "b");
    kv.store.delete(INDEX_KEY);
    expect((await vault.tree()).map((f) => f.path)).toEqual(["Sub/b.md", "a.md"]);
    expect(index().notes["a.md"]).toMatchObject({ title: "A", links: ["b"] });

    kv.store.set(INDEX_KEY, "{not json");
    expect((await vault.list()).map((e) => e.name)).toEqual(["Sub", "a.md"]);
  });

  it("recovers a lost index update when a mutation meets an unindexed note", async () => {
    await vault.write("a.md", "a");
    // Simulate a concurrent instance whose index update was lost: two notes
    // stored, neither in the index.
    const lost = { content: "lost", mtime: "2026-01-01T00:00:00.000Z", size: 4 };
    kv.store.set(`${NOTE_PREFIX}lost1.md`, JSON.stringify(lost));
    kv.store.set(`${NOTE_PREFIX}lost2.md`, JSON.stringify(lost));
    expect((await vault.tree()).map((f) => f.path)).toEqual(["a.md"]);
    // The note itself is never lost: reads go to the note key.
    expect((await vault.read("lost2.md")).content).toBe("lost");
    // Updating lost1 detects the drift and rebuilds: lost2 comes back too.
    await vault.write("lost1.md", "found");
    expect((await vault.tree()).map((f) => f.path)).toEqual(["a.md", "lost1.md", "lost2.md"]);
  });

  it("health detects a mismatch and repairs; rebuildIndex is available explicitly", async () => {
    await vault.write("a.md", "a");
    kv.store.set(
      `${NOTE_PREFIX}b.md`,
      JSON.stringify({ content: "b", mtime: "2026-01-01T00:00:00.000Z", size: 1 })
    );
    const h = await vault.health();
    expect(h).toMatchObject({ ok: true, backend: "kv" });
    expect(h.details).toMatchObject({ notes: 2, indexRepaired: true });

    kv.store.delete(`${NOTE_PREFIX}b.md`);
    expect(await vault.rebuildIndex()).toEqual({ notes: 1, totalBytes: 1 });
    expect(Object.keys(index().notes)).toEqual(["a.md"]);
  });

  it("drops a stale index entry when deleting a note that is gone", async () => {
    await vault.write("a.md", "a");
    kv.store.delete(`${NOTE_PREFIX}a.md`);
    await expect(vault.delete("a.md")).rejects.toBeInstanceOf(VaultNotFoundError);
    expect(index().notes).toEqual({});
  });

  it("works on a KV without scan/mget (list fallback)", async () => {
    kv = makeMemoryKV({ scan: false, mget: false });
    vault = createKvVaultBackend(() => kv);
    await vault.write("a.md", "café");
    await vault.write("b.md", "thé");
    kv.store.delete(INDEX_KEY);
    expect((await vault.search("cafe", { limit: 5, page: 1 })).results.map((r) => r.path)).toEqual([
      "a.md",
    ]);
    expect((await vault.tree()).length).toBe(2);
  });

  it("serialises concurrent writes in one process (no lost index entries)", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => vault.write(`n${i}.md`, `n${i}`)));
    expect(Object.keys(index().notes)).toHaveLength(20);
  });
});

describe("import helpers", () => {
  it("importNotes writes many notes with one index update and reports rejects", async () => {
    const res = await vault.importNotes(
      [
        { path: "a.md", content: "a" },
        { path: ".github/x.md", content: "x" },
        { path: "big.md", content: "x".repeat(KV_VAULT_LIMITS.maxNoteBytes + 1) },
      ],
      "Imported from GitHub"
    );
    expect(res.written).toEqual(["a.md"]);
    expect(res.rejected.map((r) => r.path)).toEqual([".github/x.md", "big.md"]);
    expect(await vault.versions()).toEqual({ "a.md": blobSha("a") });
  });
});
