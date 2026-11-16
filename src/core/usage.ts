/**
 * Kebab House phase 0 (USE-01..05) — weekly usage counters.
 *
 * One counter key per (ISO week, dimension), incremented with `kv.incr`
 * after the MCP response is sent. Only names are stored — tool names,
 * skill names, client labels — never arguments or content.
 *
 * Keys (tenant-scoped via getContextKVStore):
 *   usage:<YYYY-Www>:total
 *   usage:<YYYY-Www>:tool:<tool>
 *   usage:<YYYY-Www>:skill:<skill>
 *   usage:<YYYY-Www>:client:<label or token id>
 *   usage:<YYYY-Www>:notes
 *
 * Disabled with KEBAB_USAGE_COUNTERS=off.
 */

import { getContextKVStore } from "./request-context";
import { kvScanAll } from "./kv-store";
import { getConfig } from "./config-facade";
import { runAfterResponse } from "./after-response";
import type { ToolResult } from "./types";

const PREFIX = "usage:";
/** ~4 months: enough for a 12-week view plus margin. */
export const USAGE_TTL_SECONDS = 120 * 24 * 60 * 60;

/**
 * Tools whose successful call always adds to the user's notes. `vault_write`
 * counts only when it created a note (see `addsNote`); profile edits
 * (`my_context_update`) are not notes.
 */
const NOTE_TOOLS: ReadonlySet<string> = new Set(["vault_append", "save_article"]);

/** The skills library tools that are not themselves a skill. */
const SKILL_LIBRARY_TOOLS: ReadonlySet<string> = new Set([
  "skills_list",
  "skill_load",
  "skill_read_file",
]);

/** First text item of a result parsed as a JSON object, else null. */
function jsonBody(result: ToolResult): Record<string, unknown> | null {
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (!first || first.type !== "text" || typeof first.text !== "string") return null;
  const text = first.text.trim();
  if (!text.startsWith("{")) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Audit 2026-11 (A6): a result is a failure when it is flagged `isError`, or
 * its JSON body carries a top-level `error` (many tools report failures that
 * way without the flag).
 */
export function isFailedResult(result: ToolResult): boolean {
  if (result.isError) return true;
  const body = jsonBody(result);
  return body !== null && body.error !== undefined && body.error !== null && body.error !== false;
}

/**
 * Audit 2026-11 (A6): the skill a successful call counts for.
 *   - `skill_load`: the canonical library name, read from the loaded skill's
 *     header (`# Skill: <name>`); an unknown name loads nothing and is
 *     not counted.
 *   - legacy per-skill tools `skill_<id>` of the skills connector (only real
 *     skills are registered there).
 * Never for skills_list / skill_read_file or the template tools.
 */
export function skillForUsage(toolName: string, packId: string, result: ToolResult): string | null {
  if (packId !== "skills") return null;
  if (toolName === "skill_load") {
    const first = Array.isArray(result.content) ? result.content[0] : undefined;
    const text = first && first.type === "text" ? first.text : "";
    const m = /^# Skill: ([a-z0-9][a-z0-9_-]{0,99})\s*$/m.exec(text.split("\n", 1)[0] ?? "");
    return m ? m[1]! : null;
  }
  if (SKILL_LIBRARY_TOOLS.has(toolName) || !toolName.startsWith("skill_")) return null;
  return toolName.slice("skill_".length).replace(/_/g, "-") || null;
}

/** Audit 2026-11 (A6): whether a successful call added a note to the user's notes. */
export function addsNote(toolName: string, result: ToolResult): boolean {
  if (toolName === "vault_write") return jsonBody(result)?.action === "created";
  return NOTE_TOOLS.has(toolName);
}

export function usageCountersEnabled(): boolean {
  const v = (getConfig("KEBAB_USAGE_COUNTERS") ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}

/** ISO-8601 week id, e.g. "2026-W46" (weeks start on Monday, UTC). */
export function isoWeek(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Sunday → 7
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this week decides the year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The `n` most recent ISO weeks, newest first. */
export function recentWeeks(n: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = isoWeek(new Date(now.getTime() - i * 7 * 86_400_000));
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** Key segments may not contain ':' — keep names readable but safe. */
function seg(raw: string): string {
  return raw.replace(/[:\s]+/g, "_").slice(0, 80) || "unknown";
}

export interface ToolCallUsage {
  tool: string;
  /** Device label, else token id, else "local". */
  client: string;
  /** Skill name for skill_load / legacy skill_<id> tools. */
  skill?: string | null | undefined;
  /**
   * Whether the call added a note (see `addsNote`). When omitted, only the
   * tools that always add one (vault_append, save_article) count.
   */
  note?: boolean | undefined;
}

/** Keys to increment for one successful tool call. */
export function usageKeysFor(u: ToolCallUsage, week: string = isoWeek()): string[] {
  const base = `${PREFIX}${week}:`;
  const keys = [`${base}total`, `${base}tool:${seg(u.tool)}`, `${base}client:${seg(u.client)}`];
  if (u.skill) keys.push(`${base}skill:${seg(u.skill)}`);
  if (u.note ?? NOTE_TOOLS.has(u.tool)) keys.push(`${base}notes`);
  return keys;
}

/**
 * Record one successful tool call. Never throws and never delays the
 * response: the increments run after the response is sent.
 */
export function recordToolCall(u: ToolCallUsage): void {
  if (!usageCountersEnabled()) return;
  let kv: ReturnType<typeof getContextKVStore>;
  try {
    kv = getContextKVStore();
  } catch {
    return;
  }
  if (typeof kv.incr !== "function") return;
  const keys = usageKeysFor(u);
  runAfterResponse(async () => {
    await Promise.all(keys.map((k) => kv.incr!(k, { ttlSeconds: USAGE_TTL_SECONDS })));
  }, "usage.recordToolCall");
}

export interface WeekUsage {
  week: string;
  total: number;
  notes: number;
  tools: { name: string; count: number }[];
  skills: { name: string; count: number }[];
  clients: { name: string; count: number }[];
}

function top(map: Map<string, number>, n: number): { name: string; count: number }[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

/** Aggregate one week's counters. */
export async function readWeekUsage(week: string, topN = 10): Promise<WeekUsage> {
  const kv = getContextKVStore();
  const base = `${PREFIX}${week}:`;
  const keys = await kvScanAll(kv, `${base}*`);
  const values = await Promise.all(keys.map((k) => kv.get(k)));
  const tools = new Map<string, number>();
  const skills = new Map<string, number>();
  const clients = new Map<string, number>();
  let total = 0;
  let notes = 0;
  keys.forEach((fullKey, i) => {
    const n = Number(values[i] ?? 0) || 0;
    const rel = fullKey.slice(fullKey.indexOf(base) + base.length);
    if (rel === "total") total = n;
    else if (rel === "notes") notes = n;
    else if (rel.startsWith("tool:")) tools.set(rel.slice(5), n);
    else if (rel.startsWith("skill:")) skills.set(rel.slice(6), n);
    else if (rel.startsWith("client:")) clients.set(rel.slice(7), n);
  });
  return {
    week,
    total,
    notes,
    tools: top(tools, topN),
    skills: top(skills, topN),
    clients: top(clients, topN),
  };
}
