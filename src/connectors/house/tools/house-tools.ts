import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getCallerMeta } from "@/core/token-scope";
import { DEFAULT_PROFILE, getProfileContent, profileExists } from "@/core/profiles";
import { readWeekUsage, recentWeeks, isoWeek, type WeekUsage } from "@/core/usage";
import { getEnabledPacksLazy } from "@/core/registry";
import { skillsListPayload } from "@/connectors/skills/lib/library";
import { templateCatalog } from "@/connectors/skills/lib/templates";

/**
 * Kebab House phase 3 — tools rendered by MCP Apps views. Every result
 * carries a complete Markdown text (APP-02: the fallback for clients that
 * do not render views) and the same data as structuredContent.
 */

function result(text: string, data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: data };
}

async function profileSummary(): Promise<{ name: string; preview: string }> {
  const bound = getCallerMeta()?.profile ?? null;
  const name = bound && (await profileExists(bound)) ? bound : DEFAULT_PROFILE;
  const content = (await getProfileContent(name)) ?? "";
  const preview = content.trim().slice(0, 600);
  return { name, preview };
}

/**
 * Recent vault notes, best effort: the vault may be disabled, unconfigured
 * or slow (GitHub), and the status must render anyway.
 */
async function recentNotes(
  enabled: boolean,
  limit: number,
  since?: string
): Promise<{ path: string; date: string }[]> {
  if (!enabled) return [];
  try {
    const { getVaultBackend } = await import("@/connectors/vault/lib/select");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const notes = await Promise.race([
        getVaultBackend().recent(limit, since ? { since } : undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), 4000);
        }),
      ]);
      return notes.map((n) => ({ path: n.path, date: n.date }));
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}

function vaultEnabled(packs: { manifest: { id: string } }[]): boolean {
  return packs.some((p) => p.manifest.id === "vault");
}

// ── APP-10 kebab_status ──────────────────────────────────────────────

export const kebabStatusSchema = {};

export async function handleKebabStatus(): Promise<ToolResult> {
  const [profile, skills, packs, week] = await Promise.all([
    profileSummary(),
    skillsListPayload({}),
    getEnabledPacksLazy(),
    readWeekUsage(isoWeek()),
  ]);
  const skillNames = ((skills.skills as { name: string }[] | undefined) ?? []).map((s) => s.name);
  const connectors = packs.filter((p) => !p.manifest.core).map((p) => p.manifest.label);
  const notes = await recentNotes(vaultEnabled(packs), 5);
  const data = {
    profile,
    skills: { count: skillNames.length, names: skillNames.slice(0, 50) },
    connectors,
    notes,
    week,
  };
  const lines = [
    "# Kebab House",
    `- Profile: **${profile.name}**${profile.preview ? "" : " (empty — say “Set up my Kebab House”)"}`,
    `- Skills: ${skillNames.length}${skillNames.length ? ` (${skillNames.slice(0, 8).join(", ")}${skillNames.length > 8 ? ", …" : ""})` : ""}`,
    `- Connectors: ${connectors.length ? connectors.join(", ") : "none beyond the built-ins"}`,
    `- This week (${week.week}): ${week.total} tool calls, ${week.notes} notes added`,
  ];
  if (notes.length) lines.push(`- Recent notes: ${notes.map((n) => n.path).join(", ")}`);
  if (week.skills.length) {
    lines.push(
      `- Most used skills: ${week.skills
        .slice(0, 5)
        .map((s) => `${s.name} (${s.count})`)
        .join(", ")}`
    );
  }
  return result(lines.join("\n"), data);
}

// ── APP-12 skills_gallery ────────────────────────────────────────────

export const skillsGallerySchema = {};

export async function handleSkillsGallery(): Promise<ToolResult> {
  const [skills, templates] = await Promise.all([skillsListPayload({}), templateCatalog()]);
  const list =
    (skills.skills as { name: string; title?: string; description: string; tags: string[] }[]) ??
    [];
  const data = {
    skills: list.map((s) => ({
      name: s.name,
      title: s.title ?? s.name,
      description: s.description,
      tags: s.tags,
    })),
    templates: templates.map((t) => ({ name: t.name, title: t.title, status: t.status })),
  };
  const lines = ["# Your skills", ""];
  if (!list.length)
    lines.push("No skill yet. Ritual templates can be installed with skill_template_install.");
  for (const s of list)
    lines.push(
      `- **${s.name}** — ${s.description}${s.tags.length ? ` (${s.tags.map((t) => `#${t}`).join(" ")})` : ""}`
    );
  lines.push(
    "",
    "## Ritual templates",
    ...templates.map((t) => `- ${t.title} (${t.name}): ${t.status}`)
  );
  return result(lines.join("\n"), data);
}

// ── RCP-01 kebab_weekly_recap ────────────────────────────────────────

export const weeklyRecapSchema = {
  week: z
    .string()
    .regex(/^\d{4}-W\d{2}$/)
    .optional()
    .describe('ISO week, e.g. "2026-W46". Default: the last complete week.'),
};

function previousWeekOf(week: string): string {
  const [y, w] = week.split("-W").map(Number) as [number, number];
  // Thursday of the given ISO week, minus 7 days, re-derived as an ISO week.
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const thursday = new Date(
    jan4.getTime() + ((w - 1) * 7 + (4 - (jan4.getUTCDay() || 7))) * 86_400_000
  );
  return isoWeek(new Date(thursday.getTime() - 7 * 86_400_000));
}

/** Monday 00:00 UTC of an ISO week. */
export function weekStart(week: string): Date {
  const [y, w] = week.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mondayW1 = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000;
  return new Date(mondayW1 + (w - 1) * 7 * 86_400_000);
}

function delta(now: number, before: number): string {
  const d = now - before;
  return d === 0 ? "same as the week before" : `${d > 0 ? "+" : ""}${d} vs the week before`;
}

export async function handleWeeklyRecap(args: { week?: string | undefined }): Promise<ToolResult> {
  const week = args.week ?? recentWeeks(2)[1]!;
  const start = weekStart(week);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  const [cur, prev, packs] = (await Promise.all([
    readWeekUsage(week),
    readWeekUsage(previousWeekOf(week)),
    getEnabledPacksLazy(),
  ])) as [WeekUsage, WeekUsage, { manifest: { id: string } }[]];
  const notes = (await recentNotes(vaultEnabled(packs), 30, start.toISOString())).filter(
    (n) => !n.date || new Date(n.date).getTime() < end.getTime()
  );
  const lines = [
    `# Week ${cur.week}`,
    `- ${cur.total} tool calls (${delta(cur.total, prev.total)})`,
    `- ${cur.notes} notes added (${delta(cur.notes, prev.notes)})`,
  ];
  if (cur.skills.length)
    lines.push(`- Skills used: ${cur.skills.map((s) => `${s.name} ×${s.count}`).join(", ")}`);
  if (cur.clients.length)
    lines.push(`- Clients: ${cur.clients.map((c) => `${c.name} (${c.count})`).join(", ")}`);
  if (cur.tools.length)
    lines.push(
      `- Top tools: ${cur.tools
        .slice(0, 5)
        .map((t) => `${t.name} (${t.count})`)
        .join(", ")}`
    );
  if (notes.length) lines.push(`- Notes changed: ${notes.map((n) => n.path).join(", ")}`);
  if (cur.total === 0) lines.push("", "Nothing was recorded that week.");
  return result(lines.join("\n"), { week: cur, previous: prev, notes });
}
