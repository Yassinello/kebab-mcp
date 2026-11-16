import { z } from "zod";
import type { ToolResult } from "@/core/types";
import {
  getCallerMeta,
  getToolAccessContext,
  isConnectorAllowed,
  type CallerMeta,
} from "@/core/token-scope";
import { readWeekUsage, recentWeeks, isoWeek, type WeekUsage } from "@/core/usage";
import { getEnabledPacksLazy } from "@/core/registry";
import { getConfig } from "@/core/config-facade";
import { parseTokens, tokenId } from "@/core/auth";
import { skillsListPayload } from "@/connectors/skills/lib/library";
import { templateCatalog } from "@/connectors/skills/lib/templates";
import { readActiveProfile } from "@/connectors/context/tools/my-context";

/**
 * Kebab House phase 3 — tools rendered by MCP Apps views. Every result
 * carries a complete Markdown text (APP-02: the fallback for clients that
 * do not render views) and the same data as structuredContent.
 *
 * Both kebab_status and kebab_weekly_recap follow the caller's scope:
 * notes only when the vault connector is allowed for the caller, other
 * clients' activity only for callers with full access (no connector
 * restriction, write access); everyone else sees their own counts.
 */

function result(text: string, data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: data };
}

type Pack = { manifest: { id: string; core?: boolean; label: string } };

// ── Caller scope ─────────────────────────────────────────────────────

interface CallerView {
  /** Connector allowlist of the caller (`null` = every connector). */
  scope: Set<string> | null;
  /** The caller may see other clients' activity. */
  full: boolean;
  /** Usage-counter name of the caller (what the transport records). */
  self: string;
}

/** Same normalisation as the usage counter keys (src/core/usage.ts). */
function usageSeg(raw: string): string {
  return raw.replace(/[:\s]+/g, "_").slice(0, 80) || "unknown";
}

function hasFullAccess(meta: CallerMeta | null): boolean {
  if (!meta) return true;
  // `access` ("read" | "memory" | "full") when the transport provides it.
  const access = (meta as CallerMeta & { access?: unknown }).access;
  if (typeof access === "string") return access === "full";
  return meta.writeAllowed;
}

function callerView(): CallerView {
  const meta = getCallerMeta();
  // Outside an MCP tool call (tests, server code) there is no restriction.
  const scope = getToolAccessContext()?.connectorScope ?? null;
  return {
    scope,
    full: scope === null && hasFullAccess(meta),
    self: usageSeg(meta?.label || meta?.tokenId || "local"),
  };
}

/** Usage of the week as the caller may see it. */
function visibleUsage(week: WeekUsage, view: CallerView, vault: boolean): WeekUsage {
  if (view.full) return week;
  const own = week.clients.find((c) => c.name === view.self);
  return {
    week: week.week,
    total: own?.count ?? 0,
    notes: vault ? week.notes : 0,
    tools: [],
    skills: [],
    clients: own ? [own] : [],
  };
}

// ── Profile, notes ───────────────────────────────────────────────────

async function profileSummary(): Promise<{ name: string; preview: string }> {
  try {
    const p = await readActiveProfile();
    return { name: p.name, preview: p.content.trim().slice(0, 600) };
  } catch {
    // The vault may be down: the status renders anyway.
    const name = getCallerMeta()?.profile ?? "default";
    return { name, preview: "" };
  }
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

/** The vault is enabled AND the caller may reach it. */
function vaultVisible(packs: Pack[], view: CallerView): boolean {
  return packs.some((p) => p.manifest.id === "vault") && isConnectorAllowed(view.scope, "vault");
}

// ── Client labels ────────────────────────────────────────────────────

export const ADMIN_KEY_LABEL = "Admin key";

/**
 * Readable names for the usage counters' clients: a token without a
 * device entry is recorded by its 8-hex id. Map ids (and normalised
 * labels) to the device label, and the instance's admin key to
 * "Admin key". Best effort: on any error the raw names stay.
 */
async function clientNameMapper(): Promise<(name: string) => string> {
  const byKey = new Map<string, string>();
  const admin = new Set<string>();
  try {
    const { listDevices } = await import("@/core/devices");
    const devices = await listDevices();
    const named = new Set<string>();
    for (const d of devices) {
      const label = d.label;
      if (!label || label === "unnamed" || label === "corrupt entry") continue;
      named.add(d.tokenId);
      byKey.set(d.tokenId, label);
      byKey.set(usageSeg(label), label);
    }
    for (const t of parseTokens(getConfig("ADMIN_AUTH_TOKEN"))) admin.add(tokenId(t));
    const { getBootstrapAuthToken } = await import("@/core/first-run");
    const boot = getBootstrapAuthToken();
    if (boot) admin.add(tokenId(boot));
    // Without a separate ADMIN_AUTH_TOKEN, the dashboard opens with the MCP
    // token(s): an unnamed one is the admin key the welcome flow minted.
    if (!getConfig("ADMIN_AUTH_TOKEN")) {
      for (const t of parseTokens(getConfig("MCP_AUTH_TOKEN"))) {
        const id = tokenId(t);
        if (!named.has(id)) admin.add(id);
      }
    }
  } catch {
    // keep the raw names
  }
  return (name) => {
    if (admin.has(name)) return ADMIN_KEY_LABEL;
    const label = byKey.get(name);
    if (label) return label;
    if (name === "local") return "Local (no token)";
    if (/^[0-9a-f]{8}$/.test(name)) return `Unnamed client (${name})`;
    return name.replace(/_/g, " ");
  };
}

async function labelClients(
  clients: { name: string; count: number }[]
): Promise<{ name: string; count: number }[]> {
  if (!clients.length) return clients;
  const map = await clientNameMapper();
  const merged = new Map<string, number>();
  for (const c of clients) {
    const label = map(c.name);
    merged.set(label, (merged.get(label) ?? 0) + c.count);
  }
  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

// ── APP-10 kebab_status ──────────────────────────────────────────────

export const kebabStatusSchema = {};

export async function handleKebabStatus(): Promise<ToolResult> {
  const view = callerView();
  const [profile, skills, packs, rawWeek] = await Promise.all([
    profileSummary(),
    skillsListPayload({}),
    getEnabledPacksLazy() as Promise<Pack[]>,
    readWeekUsage(isoWeek()),
  ]);
  const vault = vaultVisible(packs, view);
  const week = visibleUsage(rawWeek, view, vault);
  if (view.full) week.clients = await labelClients(week.clients);
  const skillNames = ((skills.skills as { name: string }[] | undefined) ?? []).map((s) => s.name);
  const connectors = packs
    .filter((p) => !p.manifest.core && isConnectorAllowed(view.scope, p.manifest.id))
    .map((p) => p.manifest.label);
  const notes = await recentNotes(vault, 5);
  const data = {
    profile,
    skills: { count: skillNames.length, names: skillNames.slice(0, 50) },
    connectors,
    notes,
    week,
    scope: view.full ? "all" : "own",
  };
  const activity = view.full ? "" : " by this client";
  const lines = [
    "# Kebab House",
    `- Profile: **${profile.name}**${profile.preview ? "" : " (empty — say “Set up my Kebab House”)"}`,
    `- Skills: ${skillNames.length}${skillNames.length ? ` (${skillNames.slice(0, 8).join(", ")}${skillNames.length > 8 ? ", …" : ""})` : ""}`,
    `- Connectors: ${connectors.length ? connectors.join(", ") : "none beyond the built-ins"}`,
    `- This week (${week.week}): ${plural(week.total, "tool call")}${activity}${vault ? `, ${plural(week.notes, "note")} added` : ""}`,
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
    templates: templates.map((t) => ({
      name: t.name,
      title: t.title,
      summary: t.summary,
      example: t.example,
      status: t.status,
    })),
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
    ...templates.map(
      (t) => `- ${t.title} (${t.name}): ${t.status}. ${t.summary} Say “${t.example}”.`
    )
  );
  return result(lines.join("\n"), data);
}

// ── RCP-01 kebab_weekly_recap ────────────────────────────────────────

export const weeklyRecapSchema = {
  week: z
    .string()
    .regex(/^\d{4}-W\d{2}$/)
    .optional()
    .describe(
      'ISO week, e.g. "2026-W46". Default: the current week from Friday to Sunday, else the last complete week.'
    ),
};

function previousWeekOf(week: string): string {
  // Thursday of the given ISO week, minus 7 days, re-derived as an ISO week.
  const thursday = new Date(weekStart(week).getTime() + 3 * 86_400_000);
  return isoWeek(new Date(thursday.getTime() - 7 * 86_400_000));
}

/** Monday 00:00 UTC of an ISO week. */
export function weekStart(week: string): Date {
  const [y, w] = week.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mondayW1 = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000;
  return new Date(mondayW1 + (w - 1) * 7 * 86_400_000);
}

/**
 * Default week of the recap: a review run at the end of a week (Friday to
 * Sunday, UTC) is about that week; earlier in the week, the last complete one.
 */
export function defaultRecapWeek(now: Date = new Date()): { week: string; current: boolean } {
  const day = now.getUTCDay();
  const current = day === 5 || day === 6 || day === 0;
  return { week: current ? isoWeek(now) : recentWeeks(2, now)[1]!, current };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function delta(now: number, before: number): string {
  const d = now - before;
  return d === 0 ? "same as the week before" : `${d > 0 ? "+" : ""}${d} vs the week before`;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Up to this many changed notes are listed; the window read is larger. */
const RECAP_NOTES_SHOWN = 30;
const RECAP_NOTES_WINDOW = 200;

export async function handleWeeklyRecap(
  args: { week?: string | undefined },
  now: Date = new Date()
): Promise<ToolResult> {
  const view = callerView();
  const def = defaultRecapWeek(now);
  const week = args.week ?? def.week;
  const start = weekStart(week);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  const [rawCur, rawPrev, packs] = (await Promise.all([
    readWeekUsage(week),
    readWeekUsage(previousWeekOf(week)),
    getEnabledPacksLazy(),
  ])) as [WeekUsage, WeekUsage, Pack[]];
  const vault = vaultVisible(packs, view);
  const cur = visibleUsage(rawCur, view, vault);
  const prev = visibleUsage(rawPrev, view, vault);
  if (view.full) cur.clients = await labelClients(cur.clients);
  // The backend lists the newest changes since `start`: read a window wide
  // enough to reach past this week's later changes, then keep the week.
  const notes = (await recentNotes(vault, RECAP_NOTES_WINDOW, start.toISOString()))
    .filter((n) => !n.date || new Date(n.date).getTime() < end.getTime())
    .slice(0, RECAP_NOTES_SHOWN);
  const isCurrent = week === isoWeek(now);
  const which = isCurrent
    ? "this week so far"
    : !args.week && !def.current
      ? "last complete week"
      : "";
  const range = `${day(start)} to ${day(new Date(end.getTime() - 86_400_000))}`;
  const lines = [
    `# Week ${cur.week} (${which ? `${which}, ` : ""}${range})`,
    `- ${plural(cur.total, "tool call")}${view.full ? "" : " by this client"} (${delta(cur.total, prev.total)})`,
  ];
  if (vault) lines.push(`- ${plural(cur.notes, "note")} added (${delta(cur.notes, prev.notes)})`);
  if (cur.skills.length)
    lines.push(`- Skills used: ${cur.skills.map((s) => `${s.name} ×${s.count}`).join(", ")}`);
  if (view.full && cur.clients.length)
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
  return result(lines.join("\n"), {
    week: cur,
    previous: prev,
    notes,
    range: { start: start.toISOString(), end: end.toISOString() },
    scope: view.full ? "all" : "own",
  });
}
