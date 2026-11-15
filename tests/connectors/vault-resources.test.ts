/**
 * Phase 50 / MCP-02 — Vault resources round-trip.
 *
 * Exercises the vault ResourceProvider end-to-end:
 *  - list() returns ResourceSpec[] for all .md files in the mocked vault
 *  - read(uri) returns the markdown body for a known URI
 *  - Auth: list()/read() assume the connector is enabled (tested separately)
 *  - Invalid URIs:
 *    - path traversal (../etc/passwd) rejected with invalid_uri
 *    - non-.md extension rejected with unsupported_extension
 *    - non-vault:// scheme rejected with invalid_uri
 *
 * Mocks: vault/lib/github is mocked so no GitHub HTTP call fires.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ResourceSpec, ResourceContent } from "@/core/resources";

const vaultTreeMock = vi.fn();
const vaultReadMock = vi.fn();

vi.mock("@/connectors/vault/lib/github", async () => {
  const actual = await vi.importActual<typeof import("@/connectors/vault/lib/github")>(
    "@/connectors/vault/lib/github"
  );
  return {
    ...actual,
    vaultTree: (...args: unknown[]) => vaultTreeMock(...args),
    vaultRead: (...args: unknown[]) => vaultReadMock(...args),
    // keep the real validateVaultPath — we want it to actually guard
  };
});

describe("Phase 50 / MCP-02 — vault resources round-trip", () => {
  beforeEach(() => {
    vaultTreeMock.mockReset();
    vaultReadMock.mockReset();
    vi.resetModules();
    // Phase 2 (VLT-04): the GitHub backend is selected when its credentials
    // are present; without them the vault would use the KV backend.
    process.env.GITHUB_PAT = "test-pat";
    process.env.GITHUB_REPO = "owner/repo";
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_PAT;
    delete process.env.GITHUB_REPO;
  });

  describe("list()", () => {
    it("returns vault:// URI specs for every .md file in the tree", async () => {
      vaultTreeMock.mockResolvedValueOnce([
        { path: "notes/hello.md", name: "hello.md", type: "file", size: 42 },
        { path: "notes/nested/world.md", name: "world.md", type: "file", size: 17 },
        // Non-md file — must be filtered out.
        { path: "notes/image.png", name: "image.png", type: "file", size: 99 },
      ]);

      const { vaultResources } = await import("@/connectors/vault/resources");
      const specs: ResourceSpec[] = await vaultResources.list();

      expect(specs).toHaveLength(2);
      expect(specs[0]!.uri).toBe("vault://notes/hello.md");
      expect(specs[0]!.mimeType).toBe("text/markdown");
      expect(specs[0]!.name).toBe("notes/hello.md");
      expect(specs[1]!.uri).toBe("vault://notes/nested/world.md");
    });

    it("empty tree → empty array", async () => {
      vaultTreeMock.mockResolvedValueOnce([]);
      const { vaultResources } = await import("@/connectors/vault/resources");
      const specs = await vaultResources.list();
      expect(specs).toHaveLength(0);
    });
  });

  describe("read()", () => {
    it("returns markdown body for a known vault:// URI", async () => {
      vaultReadMock.mockResolvedValueOnce({
        path: "notes/hello.md",
        name: "hello.md",
        sha: "abc123",
        content: "# Hello\n\nWorld.\n",
        size: 17,
      });

      const { vaultResources } = await import("@/connectors/vault/resources");
      const content: ResourceContent = await vaultResources.read("vault://notes/hello.md");

      expect(content.uri).toBe("vault://notes/hello.md");
      expect(content.mimeType).toBe("text/markdown");
      expect(content.text).toBe("# Hello\n\nWorld.\n");
      expect(content.blob).toBeUndefined();
      // Verify the mock got the right path (NOT the full URI).
      expect(vaultReadMock).toHaveBeenCalledWith("notes/hello.md");
    });

    it("path traversal (..) → invalid_uri error", async () => {
      const { vaultResources } = await import("@/connectors/vault/resources");
      await expect(vaultResources.read("vault://../etc/passwd")).rejects.toThrow(
        /invalid vault path.*traversal/i
      );
      expect(vaultReadMock).not.toHaveBeenCalled();
    });

    it("absolute path → invalid_uri error", async () => {
      const { vaultResources } = await import("@/connectors/vault/resources");
      // The URI itself parses but vault:// + '/etc/passwd' strips to
      // '/etc/passwd' (leading slash) which validateVaultPath rejects.
      await expect(vaultResources.read("vault:///etc/passwd")).rejects.toThrow(
        /invalid vault path.*relative/i
      );
    });

    it("non-.md extension → unsupported_extension error", async () => {
      const { vaultResources } = await import("@/connectors/vault/resources");
      await expect(vaultResources.read("vault://image.png")).rejects.toThrow(/must end in \.md/i);
      expect(vaultReadMock).not.toHaveBeenCalled();
    });

    it("non-vault:// scheme → invalid_uri error", async () => {
      const { vaultResources } = await import("@/connectors/vault/resources");
      await expect(vaultResources.read("file:///tmp/x.md")).rejects.toThrow(
        /expected vault:\/\/ URI/
      );
    });

    it("empty path (vault://) → invalid_uri (validateVaultPath rejects empty)", async () => {
      const { vaultResources } = await import("@/connectors/vault/resources");
      await expect(vaultResources.read("vault://")).rejects.toThrow(/invalid vault path.*empty/i);
    });
  });

  describe("round-trip — list then read", () => {
    it("list first URI's body matches the read call", async () => {
      vaultTreeMock.mockResolvedValueOnce([
        { path: "daily/2026-04-22.md", name: "2026-04-22.md", type: "file", size: 50 },
      ]);
      vaultReadMock.mockResolvedValueOnce({
        path: "daily/2026-04-22.md",
        name: "2026-04-22.md",
        sha: "round-trip-sha",
        content: "## Daily note\n\nStarted Phase 50 rebrand.\n",
        size: 50,
      });

      const { vaultResources } = await import("@/connectors/vault/resources");
      const [first] = await vaultResources.list();
      expect(first).toBeDefined();
      const body = await vaultResources.read(first!.uri);
      expect(body.text).toContain("Phase 50 rebrand");
      expect(body.uri).toBe(first!.uri);
    });
  });
});
