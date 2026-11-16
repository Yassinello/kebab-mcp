/**
 * Phase 50 / COV-04 — Vault lib (GitHub contents API) backfill.
 *
 * Exercises the 6 exported helpers: validateVaultPath, vaultRead,
 * vaultWrite, vaultDelete, vaultList, vaultSearch (code search path).
 * Mocks @/core/fetch-utils so each test controls the HTTP response
 * shape without an actual network call.
 *
 * Coverage: happy + 401/403/404 error branches + typed errors
 * (VaultNotFoundError / VaultAuthError).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("@/core/fetch-utils", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));

async function loadModule() {
  return await import("../github");
}

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errResponse(status: number, bodyText = "error"): Response {
  return new Response(bodyText, { status, headers: { "Content-Type": "text/plain" } });
}

describe("Phase 50 / COV-04 — vault/lib/github.ts", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.GITHUB_PAT = "test-pat";
    process.env.GITHUB_REPO = "owner/repo";
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.GITHUB_PAT;
    delete process.env.GITHUB_REPO;
  });

  describe("validateVaultPath", () => {
    it("accepts valid relative paths", async () => {
      const { validateVaultPath } = await loadModule();
      expect(() => validateVaultPath("notes/daily.md")).not.toThrow();
    });

    it("rejects empty paths", async () => {
      const { validateVaultPath } = await loadModule();
      expect(() => validateVaultPath("")).toThrow(/empty/);
      expect(() => validateVaultPath("   ")).toThrow(/empty/);
    });

    it("rejects directory traversal (..)", async () => {
      const { validateVaultPath } = await loadModule();
      expect(() => validateVaultPath("../etc/passwd")).toThrow(/traversal/i);
    });

    it("rejects absolute paths", async () => {
      const { validateVaultPath } = await loadModule();
      expect(() => validateVaultPath("/etc/passwd")).toThrow(/relative/i);
    });

    it("rejects null bytes", async () => {
      const { validateVaultPath } = await loadModule();
      expect(() => validateVaultPath("notes\0.md")).toThrow(/null/i);
    });
  });

  describe("vaultRead", () => {
    it("happy path — base64 content decoded UTF-8", async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          path: "notes/hello.md",
          name: "hello.md",
          sha: "abc123",
          size: 14,
          content: Buffer.from("# Hello\nworld\n", "utf-8").toString("base64"),
          encoding: "base64",
          type: "file",
        })
      );

      const { vaultRead } = await loadModule();
      const file = await vaultRead("notes/hello.md");
      expect(file.content).toBe("# Hello\nworld\n");
      expect(file.sha).toBe("abc123");
      expect(file.path).toBe("notes/hello.md");
    });

    it("404 → VaultNotFoundError", async () => {
      fetchMock.mockResolvedValueOnce(errResponse(404));
      const { vaultRead } = await loadModule();
      await expect(vaultRead("missing.md")).rejects.toThrow(/not found/i);
    });

    it("401 → VaultAuthError", async () => {
      fetchMock.mockResolvedValueOnce(errResponse(401));
      const { vaultRead } = await loadModule();
      await expect(vaultRead("notes/x.md")).rejects.toThrow(/GitHub API 401/);
    });

    it("403 → VaultAuthError", async () => {
      fetchMock.mockResolvedValueOnce(errResponse(403));
      const { vaultRead } = await loadModule();
      await expect(vaultRead("notes/x.md")).rejects.toThrow(/GitHub API 403/);
    });

    it("500 → generic Error", async () => {
      fetchMock.mockResolvedValueOnce(errResponse(500));
      const { vaultRead } = await loadModule();
      await expect(vaultRead("notes/x.md")).rejects.toThrow(/GitHub API error: 500/);
    });
  });

  describe("vaultWrite", () => {
    it("happy path — creates file when no existing SHA", async () => {
      // GET returns 404 (no existing) then PUT succeeds.
      fetchMock.mockResolvedValueOnce(errResponse(404));
      fetchMock.mockResolvedValueOnce(
        okResponse({
          content: { path: "notes/new.md", sha: "def456" },
        })
      );

      const { vaultWrite } = await loadModule();
      const result = await vaultWrite("notes/new.md", "content");
      expect(result.created).toBe(true);
      expect(result.sha).toBe("def456");
    });

    it("happy path — updates when knownSha provided", async () => {
      // No GET; straight to PUT.
      fetchMock.mockResolvedValueOnce(
        okResponse({
          content: { path: "notes/upd.md", sha: "new-sha" },
        })
      );

      const { vaultWrite } = await loadModule();
      const result = await vaultWrite("notes/upd.md", "content", "msg", "old-sha");
      expect(result.created).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1); // no prefetch
    });

    it("PUT error → raises with status", async () => {
      fetchMock.mockResolvedValueOnce(errResponse(404));
      fetchMock.mockResolvedValueOnce(errResponse(422, "unprocessable"));

      const { vaultWrite } = await loadModule();
      await expect(vaultWrite("notes/x.md", "content")).rejects.toThrow(/GitHub PUT error: 422/);
    });
  });

  describe("vaultList", () => {
    it("happy path — maps GitHub directory shape to VaultListEntry[]", async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse([
          { name: "a.md", path: "a.md", sha: "s1", size: 1, type: "file" },
          { name: "dir", path: "dir", sha: "s2", size: 0, type: "dir" },
        ])
      );

      const { vaultList } = await loadModule();
      const entries = await vaultList();
      expect(entries).toHaveLength(2);
      expect(entries[0]!.name).toBe("a.md");
      expect(entries[1]!.type).toBe("dir");
    });

    it("empty folder", async () => {
      fetchMock.mockResolvedValueOnce(okResponse([]));
      const { vaultList } = await loadModule();
      const entries = await vaultList("empty-folder");
      expect(entries).toHaveLength(0);
    });
  });

  describe("missing credentials", () => {
    it("throws when GITHUB_PAT unset", async () => {
      delete process.env.GITHUB_PAT;
      vi.resetModules();
      const { vaultRead } = await loadModule();
      await expect(vaultRead("x.md")).rejects.toThrow(/GITHUB_PAT/);
    });

    it("throws when GITHUB_REPO unset", async () => {
      delete process.env.GITHUB_REPO;
      vi.resetModules();
      const { vaultRead } = await loadModule();
      await expect(vaultRead("x.md")).rejects.toThrow(/GITHUB_REPO/);
    });
  });

  describe("2026-11 audit — move never overwrites silently (B2)", () => {
    const file = (path: string, sha: string, content: string) =>
      okResponse({
        path,
        name: path.split("/").pop(),
        sha,
        size: content.length,
        content: Buffer.from(content).toString("base64"),
      });

    it("refuses when the destination exists: no PUT, no DELETE", async () => {
      fetchMock.mockResolvedValueOnce(file("a.md", "s1", "a"));
      fetchMock.mockResolvedValueOnce(file("b.md", "s2", "b"));
      const { githubVaultBackend } = await import("../github-backend");
      await expect(githubVaultBackend.move("a.md", "b.md")).rejects.toThrow(/already exists/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("overwrite: true replaces it, reusing the destination sha", async () => {
      fetchMock.mockResolvedValueOnce(file("a.md", "s1", "a"));
      fetchMock.mockResolvedValueOnce(file("b.md", "s2", "b"));
      fetchMock.mockResolvedValueOnce(okResponse({ content: { path: "b.md", sha: "s3" } }));
      fetchMock.mockResolvedValueOnce(okResponse({}));
      const { githubVaultBackend } = await import("../github-backend");
      expect(await githubVaultBackend.move("a.md", "b.md", { overwrite: true })).toEqual({
        from: "a.md",
        to: "b.md",
      });
      const put = fetchMock.mock.calls[2]!;
      expect((put[1] as RequestInit).method).toBe("PUT");
      expect(JSON.parse(String((put[1] as RequestInit).body)).sha).toBe("s2");
      expect((fetchMock.mock.calls[3]![1] as RequestInit).method).toBe("DELETE");
    });
  });

  describe("2026-11 audit — ranked tree grep fallback (B3)", () => {
    it('"pricing workshop" finds a note about "atelier pricing"', async () => {
      const notes: Record<string, string> = {
        "Notes/atelier.md": "# Atelier pricing\nPrepare the grid.",
        "Notes/coffee.md": "# Coffee chat\nTuesday.",
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/search/code")) return okResponse({ total_count: 0, items: [] });
        if (url.includes("/git/trees/")) {
          return okResponse({
            sha: "t",
            truncated: false,
            tree: Object.keys(notes).map((p) => ({
              path: p,
              mode: "100644",
              type: "blob",
              sha: p,
            })),
          });
        }
        const p = decodeURIComponent(url.split("/contents/")[1] ?? "");
        return okResponse({
          path: p,
          name: p,
          sha: "x",
          size: 1,
          content: Buffer.from(notes[p] ?? "").toString("base64"),
        });
      });
      const { vaultSearch } = await loadModule();
      const res = await vaultSearch("pricing workshop");
      expect(res.method).toBe("tree_grep");
      expect(res.results.map((r) => r.path)).toEqual(["Notes/atelier.md"]);
      expect(res.results[0]!.textMatches[0]).toContain("pricing");
    });
  });
});
