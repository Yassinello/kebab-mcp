/**
 * Kebab House phase 1 — ONB-02..05: kebab_setup state machine and template tools.
 * Audit fixes (C2.2): profile resolver (vault mode), absolute dashboard links,
 * per-profile state, read-only clients, "try it now" ending.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ActiveProfile } from "@/connectors/context/tools/my-context";

const store = new Map<string, string>();
vi.mock("@/core/request-context", async (orig) => ({
  ...(await orig<typeof import("@/core/request-context")>()),
  getContextKVStore: () => ({
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
  }),
  getCurrentTenantId: () => null,
}));
type Meta = { profile: string | null; writeAllowed: boolean; access?: string } | null;
const caller: { meta: Meta } = { meta: null };
vi.mock("@/core/token-scope", () => ({ getCallerMeta: () => caller.meta }));
vi.mock("@/core/profiles", () => ({
  DEFAULT_PROFILE: "default",
  listProfiles: async () => [{ name: "default" }, { name: "work" }],
}));
vi.mock("@/core/approvals", () => ({ getPublicOrigin: () => "https://configured.example" }));
const active: { profile: ActiveProfile | Error } = {
  profile: { name: "default", mode: "inline", content: "" },
};
vi.mock("@/connectors/context/tools/my-context", () => ({
  readActiveProfile: async () => {
    if (active.profile instanceof Error) throw active.profile;
    return active.profile;
  },
}));
const installed: string[] = [];
const catalog = [
  {
    name: "morning-brief",
    title: "Morning brief",
    description: "Use when the user starts their day…",
    summary: "Starts your day in two minutes.",
    example: "Morning brief",
    status: "available",
    installed: false,
  },
];
vi.mock("@/connectors/skills/lib/templates", () => ({
  templateCatalog: async () => catalog,
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
  setupStateKey,
} from "@/connectors/context/tools/setup";
import { runWithRequestOrigin } from "@/core/request-context";

const t = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeEach(() => {
  store.clear();
  installed.length = 0;
  caller.meta = null;
  active.profile = { name: "default", mode: "inline", content: "" };
  catalog[0]!.status = "available";
  catalog[0]!.installed = false;
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

  it("gives an absolute dashboard link derived from the incoming request", async () => {
    await handleKebabSetup({ action: "goto", step: "connectors" });
    const text = await runWithRequestOrigin("https://house.example.org", async () =>
      t(await handleKebabSetup({}))
    );
    expect(text).toContain("https://house.example.org/config?tab=connectors");
    expect(text).not.toMatch(/relative to/);
    // Outside a request: the configured public URL, still absolute.
    expect(t(await handleKebabSetup({}))).toContain(
      "https://configured.example/config?tab=connectors"
    );
  });
});

describe("kebab_setup — profile step", () => {
  it("sees a vault-mode profile and never proposes to start over", async () => {
    active.profile = {
      name: "default",
      mode: "vault",
      content: "# Me\nI build things.",
      path: "Me/profile.md",
    };
    await handleKebabSetup({ action: "goto", step: "profile" });
    const text = t(await handleKebabSetup({}));
    expect(text).toMatch(/A profile already exists \(stored as the note "Me\/profile.md"/);
    expect(text).not.toMatch(/No profile exists yet/);
  });

  it("says where an empty vault-mode profile will be saved", async () => {
    active.profile = {
      name: "default",
      mode: "vault",
      content: "",
      path: "Me/profile.md",
      missing: true,
    };
    await handleKebabSetup({ action: "goto", step: "profile" });
    expect(t(await handleKebabSetup({}))).toMatch(/saved as the note "Me\/profile.md"/);
  });

  it("does not offer to overwrite a profile it could not read", async () => {
    active.profile = new Error("GitHub down");
    await handleKebabSetup({ action: "goto", step: "profile" });
    expect(t(await handleKebabSetup({}))).toMatch(
      /could not be read \(GitHub down\)\. Do not overwrite/
    );
  });

  it("drafts from what the model already knows and points to the Profile page for other hats", async () => {
    await handleKebabSetup({ action: "goto", step: "profile" });
    const text = await runWithRequestOrigin("https://house.example.org", async () =>
      t(await handleKebabSetup({}))
    );
    expect(text).toMatch(/Do not start from zero if you already know the user/);
    expect(text).toMatch(/your own memory/);
    expect(text).toMatch(/several hats[\s\S]*https:\/\/house\.example\.org\/config\?tab=profile/);
    expect(text).not.toMatch(/IMPORTANT: this client cannot/);
  });

  it("tells a read-only client to say so and how to allow writes, instead of pretending", async () => {
    caller.meta = { profile: null, writeAllowed: false };
    await handleKebabSetup({ action: "goto", step: "profile" });
    const text = t(await handleKebabSetup({}));
    expect(text).toMatch(/this client cannot save the profile/);
    expect(text).toMatch(/Do NOT say anything was saved/);
    expect(text).toMatch(/Read \+ my profile and notes/);
    expect(text).toMatch(/\/config\?tab=devices/);
  });

  it("uses the access level when the transport provides it", async () => {
    caller.meta = { profile: null, writeAllowed: false, access: "memory" };
    await handleKebabSetup({ action: "goto", step: "rituals" });
    expect(t(await handleKebabSetup({}))).not.toMatch(/cannot install rituals/);
    caller.meta = { profile: null, writeAllowed: true, access: "read" };
    expect(t(await handleKebabSetup({}))).toMatch(/cannot install rituals/);
  });
});

describe("kebab_setup — rituals and done", () => {
  it("lists rituals with the human summary and the phrase to say", async () => {
    await handleKebabSetup({ action: "goto", step: "rituals" });
    const text = t(await handleKebabSetup({}));
    expect(text).toContain(
      '- morning-brief (available): Starts your day in two minutes. The user says: "Morning brief".'
    );
    expect(text).not.toContain("Use when the user starts");
  });

  it("ends by trying one installed ritual now", async () => {
    catalog[0]!.status = "installed";
    catalog[0]!.installed = true;
    await handleKebabSetup({ action: "goto", step: "done" });
    const text = t(await handleKebabSetup({}));
    expect(text).toMatch(/Setup is complete/);
    expect(text).toContain('Try it: say "Morning brief"');
    expect(text).toMatch(/skill_load/);
  });
});

describe("kebab_setup — state per profile", () => {
  it("keeps the default key and gives each bound profile its own state", async () => {
    expect(setupStateKey(null)).toBe("onboarding:state");
    expect(setupStateKey("default")).toBe("onboarding:state");
    expect(setupStateKey("work")).toBe("onboarding:state:work");

    // The default profile finished its setup…
    await handleKebabSetup({ action: "goto", step: "done" });
    expect(store.get("onboarding:state")).toMatch(/"done"/);

    // …a second client bound to an empty hat starts its own.
    caller.meta = { profile: "work", writeAllowed: true };
    active.profile = { name: "work", mode: "inline", content: "" };
    const text = t(await handleKebabSetup({}));
    expect(text).toMatch(/STEP 1\/4 — Interview/);
    expect(text).not.toMatch(/Setup is complete/);
    await handleKebabSetup({ action: "complete", step: "interview" });
    expect((await readSetupState()).step).toBe("profile");
    expect(store.get("onboarding:state")).toMatch(/"done"/);

    caller.meta = null;
    expect((await readSetupState()).step).toBe("done");
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
