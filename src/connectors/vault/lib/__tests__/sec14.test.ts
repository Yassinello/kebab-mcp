/** SEC-14 (2026-11 audit): vault write paths, search qualifiers, YAML bounds. */
import { describe, it, expect } from "vitest";
import { validateVaultWritePath, sanitizeSearchQuery } from "../github";
import { loadVaultYaml } from "../yaml-safe";

describe("validateVaultWritePath", () => {
  it("allows ordinary notes", () => {
    expect(() => validateVaultWritePath("Notes/today.md")).not.toThrow();
    expect(() => validateVaultWritePath("github-notes.md")).not.toThrow();
  });

  it("EXPLOIT: refuses GitHub Actions workflows and git plumbing", () => {
    expect(() => validateVaultWritePath(".github/workflows/pwn.yml")).toThrow(/not allowed/);
    expect(() => validateVaultWritePath(".GitHub/x")).toThrow();
    expect(() => validateVaultWritePath(".gitattributes")).toThrow();
    expect(() => validateVaultWritePath(".gitmodules")).toThrow();
  });

  it("still refuses traversal", () => {
    expect(() => validateVaultWritePath("../x")).toThrow();
  });
});

describe("sanitizeSearchQuery", () => {
  it("EXPLOIT: strips repo:/org:/user: qualifiers that would widen the search", () => {
    expect(sanitizeSearchQuery("password repo:me/other-private")).toBe("password");
    expect(sanitizeSearchQuery("token org:acme user:bob")).toBe("token");
    expect(sanitizeSearchQuery("-repo:x secret")).toBe("secret");
  });

  it("keeps ordinary text", () => {
    expect(sanitizeSearchQuery("meeting notes 2026")).toBe("meeting notes 2026");
  });
});

describe("loadVaultYaml", () => {
  it("parses ordinary frontmatter (dates kept)", () => {
    const v = loadVaultYaml("title: x\ndue: 2026-11-11") as Record<string, unknown>;
    expect(v.title).toBe("x");
    expect(v.due).toBeInstanceOf(Date);
  });

  it("EXPLOIT: refuses anchors/aliases (billion-laughs)", () => {
    expect(() => loadVaultYaml("a: &a [x, x]\nb: [*a, *a]")).toThrow(/anchors/);
  });

  it("refuses oversized frontmatter", () => {
    expect(() => loadVaultYaml(`k: ${"x".repeat(17 * 1024)}`)).toThrow(/too large/);
  });
});
