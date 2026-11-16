/**
 * 2026-11 audit (C1.3): /api/config/memory — the dashboard's Memory page.
 *
 * Real pipeline, real admin auth (ADMIN_AUTH_TOKEN), real KV vault backend
 * on a temporary filesystem KV.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { resetKVStoreCache } from "@/core/kv-store";
import { kvVaultBackend } from "@/connectors/vault/lib/kv-backend";
import { GET, DELETE } from "../../app/api/config/memory/route";

const ADMIN = "memory-route-admin-token-0123456789";

function req(query: string, opts: { method?: string; auth?: boolean } = {}): Request {
  return new Request(`http://localhost/api/config/memory${query}`, {
    method: opts.method ?? "GET",
    headers: {
      "x-forwarded-for": "8.8.8.8",
      ...(opts.auth === false ? {} : { authorization: `Bearer ${ADMIN}` }),
    },
  });
}

let tmpDir = "";
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-memory-route-"));
  vi.stubEnv("MYMCP_KV_PATH", path.join(tmpDir, "kv.json"));
  vi.stubEnv("ADMIN_AUTH_TOKEN", ADMIN);
  vi.stubEnv("MCP_AUTH_TOKEN", "memory-route-mcp-token-0123456789");
  vi.stubEnv("KEBAB_VAULT_BACKEND", "kv");
  vi.stubEnv("KEBAB_TRUST_URL_HOST", "");
  resetKVStoreCache();
  await kvVaultBackend.write(
    "Inbox/idea.md",
    "---\nprovenance: assistant\n---\n# Idea\nremember the kebab"
  );
  await kvVaultBackend.write("Inbox/link.md", "---\nprovenance: external\n---\nSaved article");
  await kvVaultBackend.write("Projects/house/plan.md", "# Plan\nnothing secret");
  await kvVaultBackend.write("todo.md", "my own note");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetKVStoreCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("/api/config/memory — auth", () => {
  it("refuses every verb without the admin key", async () => {
    expect((await GET(req("?view=folders", { auth: false }))).status).toBe(401);
    expect((await GET(req("?path=todo.md", { auth: false }))).status).toBe(401);
    const del = await DELETE(req("?path=todo.md", { method: "DELETE", auth: false }));
    expect(del.status).toBe(401);
    // Nothing was deleted.
    expect((await kvVaultBackend.read("todo.md")).content).toBe("my own note");
  });
});

describe("/api/config/memory — browse, search, read", () => {
  it("lists folders with note counts", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      backend: string;
      totalNotes: number;
      folders: { path: string; count: number }[];
    };
    expect(data.backend).toBe("kv");
    expect(data.totalNotes).toBe(4);
    expect(data.folders).toEqual([
      { path: "", count: 1 },
      { path: "Inbox", count: 2 },
      { path: "Projects/house", count: 1 },
    ]);
  });

  it("lists the notes directly in a folder, paginated, with their last change", async () => {
    const res = await GET(req("?folder=Inbox&limit=1"));
    const data = (await res.json()) as {
      total: number;
      notes: { path: string; name: string; updatedAt: string | null }[];
    };
    expect(data.total).toBe(2);
    expect(data.notes).toHaveLength(1);
    expect(data.notes[0]!.path).toBe("Inbox/idea.md");
    expect(data.notes[0]!.updatedAt).toMatch(/^\d{4}-/);
    const next = (await (await GET(req("?folder=Inbox&limit=1&offset=1"))).json()) as {
      notes: { path: string }[];
    };
    expect(next.notes.map((n) => n.path)).toEqual(["Inbox/link.md"]);
    const root = (await (await GET(req("?folder="))).json()) as { notes: { path: string }[] };
    expect(root.notes.map((n) => n.path)).toEqual(["todo.md"]);
  });

  it("searches through the vault backend", async () => {
    const data = (await (await GET(req("?q=kebab"))).json()) as {
      totalCount: number;
      results: { path: string; provenance: string | null }[];
    };
    expect(data.totalCount).toBe(1);
    expect(data.results[0]).toMatchObject({ path: "Inbox/idea.md", provenance: "assistant" });
    expect((await GET(req("?q=%20"))).status).toBe(400);
  });

  it("reads a note with its provenance and last change", async () => {
    const data = (await (await GET(req("?path=Inbox%2Flink.md"))).json()) as {
      content: string;
      provenance: string;
      updatedAt: string | null;
    };
    expect(data.content).toContain("Saved article");
    expect(data.provenance).toBe("external");
    expect(data.updatedAt).toMatch(/^\d{4}-/);
    const own = (await (await GET(req("?path=todo.md"))).json()) as { provenance: string };
    expect(own.provenance).toBe("user");
    expect((await GET(req("?path=missing.md"))).status).toBe(404);
  });

  it("rejects path traversal, absolute paths and non-Markdown files", async () => {
    for (const bad of ["../secrets.md", "/etc/passwd.md", "Inbox/../../x.md", "notes.json"]) {
      const res = await GET(req(`?path=${encodeURIComponent(bad)}`));
      expect(res.status, bad).toBe(400);
    }
    expect((await GET(req("?folder=..%2Fx"))).status).toBe(400);
  });
});

describe("/api/config/memory — delete", () => {
  it("deletes one note and updates the counts", async () => {
    const res = await DELETE(req("?path=Inbox%2Fidea.md", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: "Inbox/idea.md" });
    const data = (await (await GET(req(""))).json()) as { totalNotes: number };
    expect(data.totalNotes).toBe(3);
    expect((await DELETE(req("?path=Inbox%2Fidea.md", { method: "DELETE" }))).status).toBe(404);
  });

  it("refuses repository plumbing, traversal and a missing path", async () => {
    for (const bad of [".github/workflows/x.md", "../x.md", "todo.txt"]) {
      const res = await DELETE(req(`?path=${encodeURIComponent(bad)}`, { method: "DELETE" }));
      expect(res.status, bad).toBe(400);
    }
    expect((await DELETE(req("", { method: "DELETE" }))).status).toBe(400);
  });
});
