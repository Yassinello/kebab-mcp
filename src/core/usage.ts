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

const PREFIX = "usage:";
/** ~4 months: enough for a 12-week view plus margin. */
export const USAGE_TTL_SECONDS = 120 * 24 * 60 * 60;

/** Tools whose successful call adds a note to the user's memory. */
const NOTE_TOOLS: ReadonlySet<string> = new Set([
  "vault_write",
  "vault_append",
  "save_article",
  "my_context_update",
]);

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
}

/** Keys to increment for one successful tool call. */
export function usageKeysFor(u: ToolCallUsage, week: string = isoWeek()): string[] {
  const base = `${PREFIX}${week}:`;
  const keys = [`${base}total`, `${base}tool:${seg(u.tool)}`, `${base}client:${seg(u.client)}`];
  if (u.skill) keys.push(`${base}skill:${seg(u.skill)}`);
  if (NOTE_TOOLS.has(u.tool)) keys.push(`${base}notes`);
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
