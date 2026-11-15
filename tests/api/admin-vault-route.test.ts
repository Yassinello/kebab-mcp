/**
 * Kebab House phase 2 (VLT-06): /api/admin/vault — import a GitHub vault
 * into the KV backend (GitHub API simulated), rebuild the index, status.
 *
 * Real pipeline + real filesystem KV (temp file); admin auth is bypassed
 * (covered elsewhere) and the GitHub HTTP layer (fetchWithTimeout) is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

vi.mock("@/core/auth", async (orig) => ({
  ...(await orig<typeof import("@/core/auth")>()),
  checkAdminAuth: async () => null,
}));

const fetchMock = vi.fn();
vi.mock("@/core/fetch-utils", async (orig) => ({
  ...(await orig<typeof import("@/core/fetch-utils")>()),
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));

import { resetKVStoreCache } from "@/core/kv-store";
import { kvVaultBackend } from "@/connectors/vault/lib/kv-backend";
import { GET, POST } from "../../app/api/admin/vault/route";

const gitSha = (s: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(s)}\0${s}`)
    .digest("hex");

const FILES: Record<string, string> = {
  "Notes/a.md": "# A\nlinks to [[b]]",
  "Notes/b.md": "---\nresurface: 2020-01-01\n---\nB",
  "Journal/2026-11-13.md": "Journée",
};
const BIG = 300 * 1024;

function tree() {
  return {
    sha: "t",
    truncated: false,
    tree: [
      ...Object.entries(FILES).map(([p, c]) => ({
        path: p,
        mode: "100644",
        type: "blob",
        sha: gitSha(c),
        size: Buffer.byteLength(c),
      })),
      { path: "Notes", mode: "040000", type: "tree", sha: "d" },
      { path: "img.png", mode: "100644", type: "blob", sha: "p", size: 10 },
      { path: ".github/notes.md", mode: "100644", type: "blob", sha: "g", size: 3 },
      { path: "big.md", mode: "100644", type: "blob", sha: "b", size: BIG },
      { path: "Notes/broken.md", mode: "100644", type: "blob", sha: "x", size: 3 },
    ],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function githubApi(url: string): Response {
  if (url.includes("/git/trees/")) return json(tree());
  const m = /\/contents\/(.+)$/.exec(url);
  if (m) {
    const p = decodeURIComponent(m[1]!);
    if (p === "Notes/broken.md") return new Response("boom", { status: 500 });
    const c = FILES[p];
    if (c === undefined) return new Response("nf", { status: 404 });
    return json({
      path: p,
      name: p.split("/").pop(),
      sha: gitSha(c),
      size: Buffer.byteLength(c),
      content: Buffer.from(c, "utf-8").toString("base64"),
      encoding: "base64",
      type: "file",
    });
  }
  return new Response("unexpected", { status: 418 });
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/admin/vault", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let tmpDir = "";
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-vault-route-"));
  vi.stubEnv("MYMCP_KV_PATH", path.join(tmpDir, "kv.json"));
  vi.stubEnv("GITHUB_PAT", "test-pat");
  vi.stubEnv("GITHUB_REPO", "owner/vault");
  resetKVStoreCache();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => githubApi(url));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetKVStoreCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("POST /api/admin/vault import-github", () => {
  it("copies Markdown files and reports skipped / too large / failed", async () => {
    const res = await POST(post({ action: "import-github" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = (await res.json()) as {
      ok: boolean;
      backend: string;
      report: Record<string, unknown>;
    };
    expect(data.ok).toBe(true);
    // The import never switches backend: GitHub credentials are still set.
    expect(data.backend).toBe("github");
    const r = data.report as {
      totalFiles: number;
      copied: number;
      unchanged: number;
      skipped: Array<{ path: string; reason: string }>;
      tooLarge: Array<{ path: string; size: number }>;
      failed: Array<{ path: string }>;
      incomplete: boolean;
    };
    expect(r.totalFiles).toBe(7);
    expect(r.copied).toBe(3);
    expect(r.unchanged).toBe(0);
    expect(r.skipped).toEqual([
      { path: "img.png", reason: "not_markdown" },
      { path: ".github/notes.md", reason: "reserved_path" },
    ]);
    expect(r.tooLarge).toEqual([{ path: "big.md", size: BIG }]);
    expect(r.failed.map((f) => f.path)).toEqual(["Notes/broken.md"]);
    expect(r.incomplete).toBe(false);

    // The notes are in the KV vault, with their GitHub version (blob SHA).
    const note = await kvVaultBackend.read("Journal/2026-11-13.md");
    expect(note.content).toBe("Journée");
    expect(note.sha).toBe(gitSha("Journée"));
    expect(await kvVaultBackend.linkCandidates!("Notes/b.md")).toEqual(["Notes/a.md"]);
    expect(await kvVaultBackend.dueCandidates!()).toEqual(["Notes/b.md"]);
  });

  it("a second run skips unchanged notes (resumable) and only fetches changes", async () => {
    await POST(post({ action: "import-github" }));
    FILES["Notes/a.md"] = "# A\nedited on GitHub";
    fetchMock.mockClear();
    const res = await POST(post({ action: "import-github" }));
    const { report } = (await res.json()) as { report: { copied: number; unchanged: number } };
    expect(report).toMatchObject({ copied: 1, unchanged: 2 });
    const contentCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/contents/"));
    // a.md (changed) + broken.md (still failing) — unchanged notes are not fetched.
    expect(contentCalls.map((c) => String(c[0]).split("/contents/")[1])).toEqual([
      "Notes/a.md",
      "Notes/broken.md",
    ]);
    expect((await kvVaultBackend.read("Notes/a.md")).content).toBe("# A\nedited on GitHub");
    FILES["Notes/a.md"] = "# A\nlinks to [[b]]";
  });

  it("400 when GitHub is not configured", async () => {
    vi.stubEnv("GITHUB_PAT", "");
    const res = await POST(post({ action: "import-github" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "github_not_configured" });
  });

  it("surfaces a GitHub auth failure", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/git/trees/") ? new Response("bad creds", { status: 401 }) : githubApi(url)
    );
    const res = await POST(post({ action: "import-github" }));
    expect(res.status).toBe(502);
  });
});

describe("importGithubVaultToKv time budget", () => {
  it("stops between batches, reports incomplete, and the next run resumes", async () => {
    const { importGithubVaultToKv } = await import("@/connectors/vault/lib/import-github");
    let t = 0;
    // Budget already spent before the first batch.
    const first = await importGithubVaultToKv({ timeBudgetMs: 10, now: () => (t += 100) });
    expect(first).toMatchObject({ copied: 0, incomplete: true, remaining: 4 });
    const second = await importGithubVaultToKv();
    expect(second).toMatchObject({ copied: 3, incomplete: false, remaining: 0 });
  });
});

describe("/api/admin/vault other actions", () => {
  it("rebuild-index and GET status", async () => {
    await kvVaultBackend.write("x.md", "x");
    const res = await POST(post({ action: "rebuild-index" }));
    expect(await res.json()).toMatchObject({ ok: true, notes: 1, totalBytes: 1 });

    const status = await GET(new Request("http://localhost/api/admin/vault"));
    expect(await status.json()).toMatchObject({
      ok: true,
      backend: "github",
      reason: "github-credentials",
      githubConfigured: true,
      kv: { notes: 1, totalBytes: 1 },
    });

    vi.stubEnv("KEBAB_VAULT_BACKEND", "kv");
    const forced = await GET(new Request("http://localhost/api/admin/vault"));
    expect(await forced.json()).toMatchObject({ backend: "kv", reason: "forced" });
  });

  it("400 on an unknown action", async () => {
    const res = await POST(post({ action: "nope" }));
    expect(res.status).toBe(400);
  });
});
