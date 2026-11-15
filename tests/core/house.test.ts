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
  ],
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
  });
});
