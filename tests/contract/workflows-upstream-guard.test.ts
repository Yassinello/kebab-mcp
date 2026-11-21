/**
 * CI-10 (docs/specs/cdc-instances-testeurs.md): every GitHub Actions job
 * runs only in upstream. Each Kebab House instance is a copy of this repo
 * (Deploy Button copy or fork); an unguarded job would run on the owner's
 * Actions minutes and mail them on each failure.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), ".github", "workflows");
const GUARD = "if: github.repository == 'Yassinello/kebab-mcp'";

/** Job ids and their body: two-space-indented keys under `jobs:`. */
function jobs(yaml: string): Array<{ id: string; body: string }> {
  const after = yaml.split(/^jobs:\s*$/m)[1] ?? "";
  const out: Array<{ id: string; body: string }> = [];
  const re = /^ {2}([A-Za-z0-9_-]+):\s*$/gm;
  const marks = [...after.matchAll(re)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.index : after.length;
    out.push({ id: m[1]!, body: after.slice(m.index! + m[0].length, end) });
  });
  return out;
}

describe("CI-10: workflows run only in Yassinello/kebab-mcp", () => {
  const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

  it("finds the workflows", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}: every job carries the upstream guard`, () => {
      const list = jobs(readFileSync(join(DIR, file), "utf8"));
      expect(list.length).toBeGreaterThan(0);
      for (const job of list) {
        expect(job.body, `${file} → job "${job.id}"`).toContain(`    ${GUARD}`);
      }
    });
  }
});
