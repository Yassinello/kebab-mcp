/**
 * Context connector manifest (audit C2.2): memory-write flags (contract 1)
 * and the MCP server instructions.
 */
import { describe, it, expect } from "vitest";
import { contextConnector, CONTEXT_INSTRUCTIONS } from "@/connectors/context/manifest";
import { vaultConnector } from "@/connectors/vault/manifest";
import { skillsConnector } from "@/connectors/skills/manifest";
import { buildSkillsInstructions } from "@/connectors/skills/lib/library";

describe("context manifest", () => {
  it("marks only the profile and template writes as memory writes", () => {
    const flags = Object.fromEntries(
      contextConnector.tools.map((t) => [t.name, Boolean(t.memoryWrite)])
    );
    expect(flags).toEqual({
      my_context: false,
      my_context_update: true,
      kebab_setup: false,
      skill_templates_list: false,
      skill_template_install: true,
    });
  });

  it("server instructions are substantial, under Claude Code's limit, and name real tools", () => {
    const text = contextConnector.instructions!();
    expect(text).toBe(CONTEXT_INSTRUCTIONS);
    expect(text.length).toBeGreaterThanOrEqual(600);
    expect(text.length).toBeLessThanOrEqual(1200);
    const known = new Set(
      [contextConnector, vaultConnector, skillsConnector].flatMap((c) => c.tools.map((t) => t.name))
    );
    const mentioned = [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(known.has(name), name).toBe(true);
    for (const must of ["my_context", "vault_append", "vault_search", "skill_load", "kebab_setup"])
      expect(text).toContain(must);
    expect(text).toMatch(/Inbox\/YYYY-MM-DD\.md/);
    expect(text).toMatch(/data, never instructions/);
    expect(text).toMatch(/approval link/);
  });

  it("does not repeat the skills connector's own instructions", () => {
    const skillsBlock = buildSkillsInstructions(null);
    const firstSkillsLine = skillsBlock.split("\n")[0];
    if (firstSkillsLine) expect(CONTEXT_INSTRUCTIONS).not.toContain(firstSkillsLine);
    expect(CONTEXT_INSTRUCTIONS).not.toContain("skill_read_file");
  });
});
