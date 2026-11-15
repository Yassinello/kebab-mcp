/**
 * Kebab House phase 2 — the vault tools, resources and backend selection on
 * the KV backend (no GitHub credentials), against an in-memory KV.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeMemoryKV } from "./memory-kv";

const kvRef = { current: makeMemoryKV() };

vi.mock("@/core/request-context", async () => {
  const actual =
    await vi.importActual<typeof import("@/core/request-context")>("@/core/request-context");
  return { ...actual, getContextKVStore: () => kvRef.current };
});

import { handleVaultWrite } from "../../tools/vault-write";
import { handleVaultRead } from "../../tools/vault-read";
import { handleVaultAppend } from "../../tools/vault-append";
import { handleVaultSearch } from "../../tools/vault-search";
import { handleVaultList } from "../../tools/vault-list";
import { handleVaultRecent } from "../../tools/vault-recent";
import { handleVaultBacklinks } from "../../tools/vault-backlinks";
import { handleVaultMove } from "../../tools/vault-move";
import { handleVaultDelete } from "../../tools/vault-delete";
import { handleVaultDue } from "../../tools/vault-due";
import { handleVaultStats } from "../../tools/vault-stats";
import { handleVaultBatchRead } from "../../tools/vault-batch-read";
import { vaultResources } from "../../resources";
import { getVaultBackend, resolveVaultBackendKind } from "../select";

function out(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

const ENV_KEYS = ["GITHUB_PAT", "GITHUB_REPO", "KEBAB_VAULT_BACKEND", "MYMCP_VAULT_BACKEND"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  kvRef.current = makeMemoryKV();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("backend selection (VLT-04)", () => {
  it("uses kv without GitHub credentials, github with both", () => {
    expect(resolveVaultBackendKind()).toEqual({
      kind: "kv",
      reason: "default",
      githubConfigured: false,
    });
    process.env.GITHUB_PAT = "p";
    expect(resolveVaultBackendKind().kind).toBe("kv"); // repo missing
    process.env.GITHUB_REPO = "o/r";
    expect(resolveVaultBackendKind()).toEqual({
      kind: "github",
      reason: "github-credentials",
      githubConfigured: true,
    });
    expect(getVaultBackend().kind).toBe("github");
  });

  it("KEBAB_VAULT_BACKEND forces either backend; invalid values are ignored", () => {
    process.env.GITHUB_PAT = "p";
    process.env.GITHUB_REPO = "o/r";
    process.env.KEBAB_VAULT_BACKEND = "kv";
    expect(resolveVaultBackendKind()).toMatchObject({ kind: "kv", reason: "forced" });
    expect(getVaultBackend().kind).toBe("kv");

    delete process.env.GITHUB_PAT;
    process.env.KEBAB_VAULT_BACKEND = "GitHub";
    expect(resolveVaultBackendKind()).toMatchObject({ kind: "github", reason: "forced" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.KEBAB_VAULT_BACKEND = "s3";
    expect(resolveVaultBackendKind()).toMatchObject({ kind: "kv", reason: "default" });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("vault tools on the KV backend", () => {
  it("write → read → append → batch read", async () => {
    const w = out(await handleVaultWrite({ path: "Notes/a.md", content: "# A\nbody" }));
    expect(w).toMatchObject({ success: true, action: "created", path: "Notes/a.md" });
    expect(w.provenance).toBe("assistant");

    const r = out(await handleVaultRead({ path: "Notes/a.md" }));
    expect(r).toMatchObject({ path: "Notes/a.md", name: "a.md", sha: w.sha, body: "# A\nbody" });
    expect(r.frontmatter).toEqual({ provenance: "assistant" });

    const a = out(await handleVaultAppend({ path: "Notes/a.md", content: "more" }));
    expect(a).toMatchObject({ success: true, path: "Notes/a.md", appendedLength: 4 });

    const b = out(await handleVaultBatchRead({ paths: ["Notes/a.md", "missing.md"] }));
    expect(b).toMatchObject({ total: 2, success: 1, failed: 1 });

    // Update with a stale sha is refused (optimistic concurrency).
    await expect(
      handleVaultWrite({ path: "Notes/a.md", content: "x", sha: w.sha as string })
    ).rejects.toThrow(/changed since/);
  });

  it("search, list, recent, stats", async () => {
    await handleVaultWrite({ path: "Projects/cadens.md", content: "# Cadens\nLe café du matin" });
    await handleVaultWrite({ path: "Inbox/todo.md", content: "Penser au cafe" });
    const s = out(await handleVaultSearch({ query: "café" }));
    expect(s).toMatchObject({ method: "kv_index", totalCount: 2, page: 1, count: 2 });
    expect((s.results as Array<{ provenance: string }>)[0]!.provenance).toBe("assistant");

    const l = out(await handleVaultList({}));
    expect(l).toMatchObject({ folder: "/", count: 2 });

    const rec = out(await handleVaultRecent({ n: 1 }));
    expect(rec).toMatchObject({ count: 1 });
    expect((rec.notes as Array<{ path: string }>)[0]!.path).toBe("Inbox/todo.md");

    const st = out(await handleVaultStats({}));
    expect(st).toMatchObject({ totalNotes: 2, inboxCount: 1, folderCount: 2 });
  });

  it("backlinks come from the link index", async () => {
    await handleVaultWrite({ path: "Projects/cadens.md", content: "# Cadens\nsee [[ideas]]" });
    await handleVaultWrite({ path: "Journal/d1.md", content: "Worked on [[cadens]] today" });
    await handleVaultWrite({ path: "Journal/d2.md", content: "[[Projects/cadens|the project]]" });
    await handleVaultWrite({ path: "Journal/d3.md", content: "nothing" });
    const res = out(await handleVaultBacklinks({ path: "Projects/cadens.md" }));
    const bl = res.backlinks as { count: number; notes: Array<{ path: string; context: string }> };
    expect(bl.notes.map((n) => n.path)).toEqual(["Journal/d1.md"]);
    // `[[Projects/cadens|…]]` is matched by pattern, but the context lookup
    // (unchanged tool logic) keys on `[[cadens` — same as on GitHub.
    expect(res.forwardLinks).toEqual({ count: 1, links: ["ideas"] });
  });

  it("due notes", async () => {
    await handleVaultWrite({
      path: "Ideas/old.md",
      content: "---\ntitle: Old idea\nresurface: 2020-01-01\n---\nRevisit this.",
    });
    await handleVaultWrite({
      path: "Ideas/later.md",
      content: "---\nresurface: 2999-01-01\n---\nNot yet.",
    });
    await handleVaultWrite({ path: "Ideas/plain.md", content: "no frontmatter" });
    const res = out(await handleVaultDue({ before: "2026-11-13" }));
    expect(res).toMatchObject({ cutoffDate: "2026-11-13", count: 1 });
    expect(res.notes).toEqual([
      {
        path: "Ideas/old.md",
        title: "Old idea",
        resurface: "2020-01-01",
        snippet: "Revisit this.",
      },
    ]);
  });

  it("move and delete", async () => {
    await handleVaultWrite({ path: "Inbox/n.md", content: "n" });
    expect(out(await handleVaultMove({ from: "Inbox/n.md", to: "Done/n.md" }))).toEqual({
      success: true,
      action: "moved",
      from: "Inbox/n.md",
      to: "Done/n.md",
    });
    expect(out(await handleVaultDelete({ path: "Done/n.md" }))).toEqual({
      success: true,
      action: "deleted",
      path: "Done/n.md",
    });
    await expect(handleVaultRead({ path: "Done/n.md" })).rejects.toThrow(/not found/i);
  });
});

describe("vault:// resources on the KV backend", () => {
  it("lists and reads notes", async () => {
    await handleVaultWrite({ path: "Notes/hello.md", content: "Hello" });
    await handleVaultWrite({ path: "Notes/data.txt", content: "not a resource" });
    const specs = await vaultResources.list();
    expect(specs.map((s) => s.uri)).toEqual(["vault://Notes/hello.md"]);
    const body = await vaultResources.read("vault://Notes/hello.md");
    expect(body.text).toContain("Hello");
    await expect(vaultResources.read("vault://../x.md")).rejects.toThrow(/invalid vault path/);
  });
});
