/**
 * Contract 5 — the public "Set it up from Claude" guide: it exists, covers
 * the journey in order, is linked from the README (near the top) and has
 * an in-app twin in content/docs. Relative links in the guide resolve.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@/core/frontmatter";
import { SETUP_PHRASE } from "@/core/client-links";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("docs/CONNECT-CLAUDE.md", () => {
  const guide = read("docs/CONNECT-CLAUDE.md");

  it("walks the journey in order", () => {
    const sections = [
      "## 1. Deploy",
      "## 2. Connect Claude",
      "## 3. Say the phrase",
      "## 4. What Claude will ask",
      "## 5. Connectors",
      "## 6. The Kebab House skill",
      "## 7. Confirming changes",
      "## 8. Other AI clients",
      "## 9. Troubleshooting",
    ];
    const at = sections.map((s) => guide.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(guide).toContain(`> ${SETUP_PHRASE}`);
    expect(guide).toContain("Settings → Connectors → Add custom connector");
    expect(guide).toContain("Settings → Capabilities → Skills");
    expect(guide).toContain("kebab_config");
    expect(guide).toMatch(/15 minutes/);
    expect(guide).toMatch(/never type them in the chat/i);
  });

  it("has no dead relative link", () => {
    const links = [...guide.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
    const relative = links.filter((l) => !/^(https?:|#|mailto:)/.test(l));
    expect(relative.length).toBeGreaterThan(0);
    for (const l of relative) {
      expect(existsSync(path.join(ROOT, "docs", l.replace(/#.*$/, ""))), l).toBe(true);
    }
  });

  it("is linked from the README, near the top and in the docs list", () => {
    const readme = read("README.md");
    const first = readme.indexOf("docs/CONNECT-CLAUDE.md");
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(readme.indexOf("## In 30 seconds"));
    expect(readme.slice(0, first)).toContain("Set it up from Claude");
    const docsList = readme.slice(readme.indexOf("## Documentation"));
    expect(docsList.slice(0, docsList.indexOf("\n## ", 5))).toContain("(docs/CONNECT-CLAUDE.md)");
  });
});

describe("content/docs/connect-claude.md (in-app docs)", () => {
  it("is listed in the dashboard Documentation, right after Getting started", () => {
    const { meta, body } = parseFrontmatter(read("content/docs/connect-claude.md"));
    const order = (file: string) =>
      Number(parseFrontmatter(read(`content/docs/${file}`)).meta.order);
    expect(meta.title).toBe("Set it up from Claude");
    expect(Number(meta.order)).toBeGreaterThan(order("getting-started.md"));
    expect(Number(meta.order)).toBeLessThan(order("connectors.md"));
    expect(body).toContain(`> ${SETUP_PHRASE}`);
    expect(body).toContain("/config?tab=skills&panel=kebab-skill");
  });
});
