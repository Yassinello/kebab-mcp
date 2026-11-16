/**
 * Kebab House phase 3 — APP-01/02/10/12, RCP-01: MCP Apps views and tools.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

type Meta = { tokenId: string | null; label: string | null; profile: null; writeAllowed: boolean };
const caller: { meta: Meta | null } = { meta: null };
vi.mock("@/core/token-scope", async (orig) => ({
  ...(await orig<typeof import("@/core/token-scope")>()),
  getCallerMeta: () => caller.meta,
}));
vi.mock("@/connectors/context/tools/my-context", () => ({
  readActiveProfile: async () => ({ name: "default", mode: "inline", content: "# Me\nBuilder." }),
}));
const weeks: Record<string, { total: number; notes: number }> = {
  "2026-W45": { total: 12, notes: 3 },
  "2026-W44": { total: 5, notes: 3 },
};
const ADMIN_TOKEN = "admin-key-for-tests-0123456789abcdef";
const adminId = createHash("sha256").update(ADMIN_TOKEN).digest("hex").slice(0, 8);
vi.mock("@/core/usage", async (orig) => {
  const real = (await orig()) as typeof import("@/core/usage");
  return {
    ...real,
    readWeekUsage: async (week: string) => ({
      week,
      total: weeks[week]?.total ?? 0,
      notes: weeks[week]?.notes ?? 0,
      tools: week === "2026-W45" ? [{ name: "vault_search", count: 6 }] : [],
      skills: week === "2026-W45" ? [{ name: "morning-brief", count: 4 }] : [],
      clients:
        week === "2026-W45"
          ? [
              { name: adminId, count: 7 },
              { name: "Claude_Desktop", count: 3 },
              { name: "Phone", count: 2 },
            ]
          : [],
    }),
  };
});
vi.mock("@/core/devices", () => ({
  listDevices: async () => [
    { tokenId: "1234abcd", label: "Claude Desktop" },
    { tokenId: "9999ffff", label: "Phone" },
  ],
}));
vi.mock("@/core/first-run", () => ({ getBootstrapAuthToken: () => null }));
vi.mock("@/core/registry", () => ({
  getEnabledPacksLazy: async () => [
    { manifest: { id: "skills", core: true, label: "Skills" } },
    { manifest: { id: "slack", core: false, label: "Slack" } },
    { manifest: { id: "vault", core: true, label: "Memory Vault" } },
  ],
}));
type Note = { path: string; message: string; date: string; author: string };
const notesStore: { list: Note[] } = { list: [] };
const BASE_NOTES: Note[] = [
  { path: "Inbox/later.md", message: "add", date: "2026-11-12T09:00:00Z", author: "me" },
  { path: "Inbox/idea.md", message: "add", date: "2026-11-04T09:00:00Z", author: "me" },
];
// Newest first, `limit` applied after `since`, like the real backends.
const recent = vi.fn(async (limit: number, opts?: { since?: string }) =>
  notesStore.list.filter((n) => !opts?.since || n.date >= opts.since).slice(0, limit)
);
beforeEach(() => {
  caller.meta = null;
  notesStore.list = [...BASE_NOTES];
  vi.stubEnv("ADMIN_AUTH_TOKEN", ADMIN_TOKEN);
});
vi.mock("@/connectors/vault/lib/select", () => ({
  getVaultBackend: () => ({ recent }),
}));
vi.mock("@/connectors/skills/lib/library", () => ({
  skillsListPayload: async () => ({
    count: 1,
    skills: [
      {
        name: "morning-brief",
        title: "Morning brief",
        description: "Use when…",
        tags: ["rituals"],
      },
    ],
  }),
}));
vi.mock("@/connectors/skills/lib/templates", () => ({
  templateCatalog: async () => [
    {
      name: "remember",
      title: "Remember",
      summary: "Keeps what you mention.",
      example: "Remember that…",
      status: "available",
    },
  ],
}));

import { houseConnector, uiResources } from "@/connectors/house/manifest";
import {
  defaultRecapWeek,
  handleKebabStatus,
  handleSkillsGallery,
  handleWeeklyRecap,
  weekStart,
} from "@/connectors/house/tools/house-tools";
import { UI_MIME_TYPE } from "@/connectors/house/views/bridge";
import { runWithToolAccess } from "@/core/token-scope";

describe("ui:// resources (APP-01)", () => {
  it("lists three self-contained views with the MCP Apps MIME type", async () => {
    const list = await uiResources.list();
    expect(list.map((r) => r.uri)).toEqual([
      "ui://kebab-house/status",
      "ui://kebab-house/gallery",
      "ui://kebab-house/approve",
    ]);
    for (const r of list) {
      expect(r.mimeType).toBe(UI_MIME_TYPE);
      const { text } = await uiResources.read(r.uri);
      expect(text).toMatch(/^<!doctype html>/);
      expect(text).toContain('"ui/initialize"');
      // No external script, stylesheet, font or image.
      expect(text).not.toMatch(/(src|href)=["']https?:/);
      // Data is inserted as text, never as markup.
      expect(text).not.toContain("innerHTML");
    }
    await expect(uiResources.read("ui://kebab-house/nope")).rejects.toThrow();
  });
});

describe("tools (APP-02/10/12, RCP-01)", () => {
  it("link their view through _meta and always return a complete text fallback", async () => {
    const byName = Object.fromEntries(houseConnector.tools.map((t) => [t.name, t]));
    expect(byName.kebab_status!.meta).toMatchObject({
      ui: { resourceUri: "ui://kebab-house/status" },
    });
    expect(byName.skills_gallery!.meta).toMatchObject({
      "ui/resourceUri": "ui://kebab-house/gallery",
    });

    const status = await handleKebabStatus();
    expect(status.content[0]!.text).toContain("Profile: **default**");
    expect(status.content[0]!.text).toContain("Connectors: Slack");
    expect(status.structuredContent).toMatchObject({ skills: { count: 1 }, connectors: ["Slack"] });

    const gallery = await handleSkillsGallery();
    expect(gallery.content[0]!.text).toContain("**morning-brief**");
    expect((gallery.structuredContent as { templates: unknown[] }).templates).toHaveLength(1);
  });

  it("recaps a week against the one before", async () => {
    const r = await handleWeeklyRecap({ week: "2026-W45" });
    const text = r.content[0]!.text;
    expect(text).toContain("# Week 2026-W45 (2026-11-02 to 2026-11-08)");
    expect(text).toContain("12 tool calls (+7 vs the week before)");
    expect(text).toContain("3 notes added (same as the week before)");
    expect(text).toContain("morning-brief ×4");
    // Only the notes of that week (Mon 2 Nov → Sun 8 Nov 2026).
    expect(text).toContain("Notes changed: Inbox/idea.md");
    expect(text).not.toContain("Inbox/later.md");
  });

  it("finds last week's notes even after more than 30 changes this week", async () => {
    const thisWeek: Note[] = Array.from({ length: 40 }, (_, i) => ({
      path: `Inbox/n${i}.md`,
      message: "add",
      date: `2026-11-1${i % 3}T0${i % 9}:00:00Z`,
      author: "me",
    }));
    notesStore.list = [...thisWeek, BASE_NOTES[1]!];
    const r = await handleWeeklyRecap({ week: "2026-W45" });
    expect(r.content[0]!.text).toContain("Notes changed: Inbox/idea.md");
  });

  it("defaults to the current week from Friday to Sunday, else the last complete one, and says which", async () => {
    expect(defaultRecapWeek(new Date("2026-11-13T10:00:00Z"))).toEqual({
      week: "2026-W46",
      current: true,
    });
    expect(defaultRecapWeek(new Date("2026-11-15T22:00:00Z")).week).toBe("2026-W46");
    expect(defaultRecapWeek(new Date("2026-11-11T10:00:00Z"))).toEqual({
      week: "2026-W45",
      current: false,
    });
    const friday = await handleWeeklyRecap({}, new Date("2026-11-13T10:00:00Z"));
    expect(friday.content[0]!.text).toMatch(/^# Week 2026-W46 \(this week so far, 2026-11-09/);
    const wednesday = await handleWeeklyRecap({}, new Date("2026-11-11T10:00:00Z"));
    expect(wednesday.content[0]!.text).toMatch(/^# Week 2026-W45 \(last complete week, /);
  });

  it("shows clients by device label, and the admin key as such", async () => {
    const r = await handleWeeklyRecap({ week: "2026-W45" });
    const text = r.content[0]!.text;
    expect(text).toContain("Clients: Admin key (7), Claude Desktop (3), Phone (2)");
    expect(text).not.toContain(adminId);
  });

  it("shows recent vault notes in the status, and survives a failing vault", async () => {
    const ok = await handleKebabStatus();
    expect(ok.content[0]!.text).toContain("Recent notes: Inbox/later.md, Inbox/idea.md");
    recent.mockRejectedValueOnce(new Error("GitHub down"));
    const down = await handleKebabStatus();
    expect(down.content[0]!.text).not.toContain("Recent notes");
    expect((down.structuredContent as { notes: unknown[] }).notes).toEqual([]);
  });

  it("a scoped client sees neither notes, other connectors nor other clients", async () => {
    caller.meta = { tokenId: "9999ffff", label: "Phone", profile: null, writeAllowed: true };
    const scoped = (
      fn: () => Promise<{ content: { text: string }[]; structuredContent?: unknown }>
    ) => runWithToolAccess({ connectorScope: new Set(["skills"]) }, fn);

    const status = await scoped(handleKebabStatus);
    const text = status.content[0]!.text;
    expect(text).not.toContain("Recent notes");
    expect(text).toContain("Connectors: none beyond the built-ins");
    // kebab_status reads the current week (no usage in this fixture).
    expect(text).toMatch(/0 tool calls by this client\n|0 tool calls by this client$/);
    expect(status.structuredContent).toMatchObject({
      notes: [],
      connectors: [],
      scope: "own",
      week: { total: 0, tools: [], skills: [], clients: [] },
    });

    const recap = await scoped(() => handleWeeklyRecap({ week: "2026-W45" }));
    const rt = recap.content[0]!.text;
    expect(rt).not.toMatch(/Clients:|Notes changed|notes added|Admin key|Claude Desktop/);
    expect(rt).toContain("2 tool calls by this client");
  });

  it("a client with the vault in scope sees notes, but still only its own activity", async () => {
    caller.meta = { tokenId: "9999ffff", label: "Phone", profile: null, writeAllowed: true };
    const r = await runWithToolAccess({ connectorScope: new Set(["skills", "vault"]) }, () =>
      handleWeeklyRecap({ week: "2026-W45" })
    );
    expect(r.content[0]!.text).toContain("Notes changed: Inbox/idea.md");
    expect(r.content[0]!.text).not.toContain("Clients:");
  });

  it("a read-only client without connector restriction only sees its own activity", async () => {
    caller.meta = { tokenId: "9999ffff", label: "Phone", profile: null, writeAllowed: false };
    const r = await runWithToolAccess({ connectorScope: null }, () =>
      handleWeeklyRecap({ week: "2026-W45" })
    );
    expect(r.content[0]!.text).not.toContain("Clients:");
    expect(r.content[0]!.text).toContain("Notes changed: Inbox/idea.md");
  });

  it("computes the Monday of an ISO week", () => {
    expect(weekStart("2026-W45").toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(weekStart("2026-W01").toISOString()).toBe("2025-12-29T00:00:00.000Z");
  });
});

describe("weekly-review template (RCP-02)", () => {
  it("uses kebab_weekly_recap when available, with a vault fallback", async () => {
    const { readFileSync } = await import("node:fs");
    const md = readFileSync("content/skill-templates/weekly-review/SKILL.md", "utf8");
    expect(md).toContain("kebab_weekly_recap");
    expect(md).toContain("vault_recent");
  });
});
