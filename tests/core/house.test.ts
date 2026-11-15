/**
 * Kebab House phase 3 — APP-01/02/10/12, RCP-01: MCP Apps views and tools.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/core/token-scope", () => ({ getCallerMeta: () => null }));
vi.mock("@/core/profiles", () => ({
  DEFAULT_PROFILE: "default",
  profileExists: async () => true,
  getProfileContent: async () => "# Me\nBuilder.",
}));
const weeks: Record<string, { total: number; notes: number }> = {
  "2026-W45": { total: 12, notes: 3 },
  "2026-W44": { total: 5, notes: 3 },
};
vi.mock("@/core/usage", async (orig) => {
  const real = (await orig()) as typeof import("@/core/usage");
  return {
    ...real,
    readWeekUsage: async (week: string) => ({
      week,
      total: weeks[week]?.total ?? 0,
      notes: weeks[week]?.notes ?? 0,
      tools: [],
      skills: week === "2026-W45" ? [{ name: "morning-brief", count: 4 }] : [],
      clients: [],
    }),
  };
});
vi.mock("@/core/registry", () => ({
  getEnabledPacksLazy: async () => [
    { manifest: { core: true, label: "Skills" } },
    { manifest: { core: false, label: "Slack" } },
    { manifest: { id: "vault", core: true, label: "Memory Vault" } },
  ],
}));
const recent = vi.fn(async (_limit: number, opts?: { since?: string }) =>
  [
    { path: "Inbox/idea.md", message: "add", date: "2026-11-04T09:00:00Z", author: "me" },
    { path: "Inbox/later.md", message: "add", date: "2026-11-12T09:00:00Z", author: "me" },
  ].filter((n) => !opts?.since || n.date >= opts.since)
);
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
  templateCatalog: async () => [{ name: "remember", title: "Remember", status: "available" }],
}));

import { houseConnector, uiResources } from "@/connectors/house/manifest";
import {
  handleKebabStatus,
  handleSkillsGallery,
  handleWeeklyRecap,
  weekStart,
} from "@/connectors/house/tools/house-tools";
import { UI_MIME_TYPE } from "@/connectors/house/views/bridge";

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
    expect(text).toContain("# Week 2026-W45");
    expect(text).toContain("12 tool calls (+7 vs the week before)");
    expect(text).toContain("3 notes added (same as the week before)");
    expect(text).toContain("morning-brief ×4");
    // Only the notes of that week (Mon 2 Nov → Sun 8 Nov 2026).
    expect(text).toContain("Notes changed: Inbox/idea.md");
    expect(text).not.toContain("Inbox/later.md");
    expect(recent).toHaveBeenLastCalledWith(30, { since: "2026-11-02T00:00:00.000Z" });
  });

  it("shows recent vault notes in the status, and survives a failing vault", async () => {
    const ok = await handleKebabStatus();
    expect(ok.content[0]!.text).toContain("Recent notes: Inbox/idea.md, Inbox/later.md");
    recent.mockRejectedValueOnce(new Error("GitHub down"));
    const down = await handleKebabStatus();
    expect(down.content[0]!.text).not.toContain("Recent notes");
    expect((down.structuredContent as { notes: unknown[] }).notes).toEqual([]);
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
