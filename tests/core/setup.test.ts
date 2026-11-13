/**
 * Kebab House phase 1 — ONB-02..05: kebab_setup state machine and template tools.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => ({
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
  }),
  getCurrentTenantId: () => null,
}));
vi.mock("@/core/token-scope", () => ({ getCallerMeta: () => null }));
vi.mock("@/core/profiles", () => ({
  DEFAULT_PROFILE: "default",
  getProfileContent: async () => "",
  listProfiles: async () => [{ name: "default" }],
}));
const installed: string[] = [];
vi.mock("@/connectors/skills/lib/templates", () => ({
  templateCatalog: async () => [
    {
      name: "morning-brief",
      title: "Morning brief",
      description: "Use when…",
      status: "available",
    },
  ],
  installSkillTemplate: async (name: string) => {
    if (name !== "morning-brief") return { ok: false, error: "Unknown template", status: 404 };
    installed.push(name);
    return { ok: true, id: "morning_brief", name, action: "created" };
  },
}));

import {
  handleKebabSetup,
  handleSkillTemplateInstall,
  readSetupState,
} from "@/connectors/context/tools/setup";

const t = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeEach(() => {
  store.clear();
  installed.length = 0;
});

describe("kebab_setup", () => {
  it("starts with the interview and walks through every step in order", async () => {
    expect(t(await handleKebabSetup({}))).toMatch(/STEP 1\/4 — Interview/);
    expect(t(await handleKebabSetup({ action: "complete", step: "interview" }))).toMatch(
      /STEP 2\/4 — Profile/
    );
    expect(t(await handleKebabSetup({ action: "complete" }))).toMatch(
      /STEP 3\/4 — Rituals[\s\S]*morning-brief/
    );
    expect(t(await handleKebabSetup({ action: "complete" }))).toMatch(/STEP 4\/4 — Connectors/);
    expect(t(await handleKebabSetup({ action: "complete" }))).toMatch(/Setup is complete/);
    expect((await readSetupState()).step).toBe("done");
  });

  it("never moves backwards on a late complete, supports goto and reset, and resumes", async () => {
    await handleKebabSetup({ action: "goto", step: "rituals" });
    await handleKebabSetup({ action: "complete", step: "interview" });
    expect((await readSetupState()).step).toBe("rituals");
    expect(t(await handleKebabSetup({}))).toMatch(/Rituals/);
    await handleKebabSetup({ action: "reset" });
    expect((await readSetupState()).step).toBe("interview");
  });

  it("the connectors step forbids secrets in the chat", async () => {
    await handleKebabSetup({ action: "goto", step: "connectors" });
    expect(t(await handleKebabSetup({}))).toMatch(
      /Never ask the user to paste a password, token or API key/
    );
  });
});

describe("skill_template_install", () => {
  it("installs a known template and reports unknown ones as errors", async () => {
    expect(t(await handleSkillTemplateInstall({ name: "morning-brief" }))).toMatch(/created/);
    expect(installed).toEqual(["morning-brief"]);
    const bad = await handleSkillTemplateInstall({ name: "nope" });
    expect(bad.isError).toBe(true);
  });
});
