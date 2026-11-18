import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";
import { getContextKVStore, getCurrentTenantId } from "@/core/request-context";
import { listProfiles } from "@/core/profiles";
import { listDevices, type DeviceRow } from "@/core/devices";
import { readWeekUsage, recentWeeks, usageCountersEnabled } from "@/core/usage";
import { listSkills } from "@/connectors/skills/store";
import { templateCatalog } from "@/connectors/skills/lib/templates";
import { getVaultBackend } from "@/connectors/vault/lib/select";
import { readSetupState } from "@/connectors/context/tools/setup";

/**
 * 2026-11 audit (C1.1) — GET /api/config/hub: the state behind the
 * Overview's "Your Kebab House" card and "Getting started" checklist.
 *
 * Every part is computed independently: one failing source (vault
 * unreachable, devices unreadable…) leaves its field `null` and adds a
 * line to `errors`, the rest still renders.
 */

/** Contract 2: written by the MCP transport when a client authenticates with the admin key. */
const ADMIN_TOKEN_MCP_LAST_KEY = "security:admin-token-mcp-last";

/**
 * When the owner added the Kebab House skill (contract 3). Written by the
 * dashboard when they download it, or when they tick "I did it" (it may
 * have been added from another device or unzipped by hand). The download
 * route itself stays free of side effects.
 */
const KEBAB_SKILL_ADDED_KEY = "hub:kebab-skill-added";

/** Weeks of usage counters scanned to find the AI clients in use. */
const CLIENT_WEEKS = 4;
const NOTES_TIMEOUT_MS = 4000;

interface HubClient {
  label: string;
  kind: "token" | "oauth";
  lastSeenAt: string | null;
}

interface HubSummary {
  profile: {
    mode: "inline" | "vault";
    bytes: number;
    updatedAt: string | null;
    by: string | null;
    /** Inline content present, or the profile lives in the vault. */
    filled: boolean;
    otherProfiles: number;
  } | null;
  skills: { count: number; rituals: { installed: number; total: number } } | null;
  clients: {
    /** Distinct AI clients seen in use (devices with activity, OAuth clients, usage counters). */
    connected: number;
    devices: number;
    oauth: number;
    lastActivity: string | null;
    list: HubClient[];
    /** Client names seen by the usage counters over the last weeks. */
    seen: string[];
  } | null;
  notes: { count: number; backend: string } | null;
  /** ISO time an AI client last used the admin key (contract 2), else null. */
  adminKeyUsedAt: string | null;
  /** Conversational onboarding ("Set up my Kebab House"), default profile. */
  setup: { step: string; updatedAt: string | null } | null;
  /** ISO time the owner added the Kebab House skill, else null. */
  kebabSkillAddedAt: string | null;
  errors: string[];
}

async function settle<T>(label: string, errors: string[], fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${toMsg(err)}`);
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

function latest(dates: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (!d || Number.isNaN(Date.parse(d))) continue;
    if (!best || Date.parse(d) > Date.parse(best)) best = d;
  }
  return best;
}

async function profilePart(): Promise<HubSummary["profile"]> {
  const all = await listProfiles();
  const def = all.find((p) => p.name === "default");
  if (!def) return null;
  return {
    mode: def.mode,
    bytes: def.bytes,
    updatedAt: def.updatedAt,
    by: def.by ?? null,
    filled: def.mode === "vault" || def.bytes > 0,
    otherProfiles: all.length - 1,
  };
}

async function skillsPart(): Promise<HubSummary["skills"]> {
  const [skills, catalog] = await Promise.all([listSkills(), templateCatalog()]);
  return {
    count: skills.length,
    rituals: { installed: catalog.filter((t) => t.installed).length, total: catalog.length },
  };
}

async function clientsPart(): Promise<HubSummary["clients"]> {
  // Devices are managed at root scope only (see /api/admin/devices).
  const rows: DeviceRow[] = getCurrentTenantId() === null ? await listDevices() : [];
  const active = rows.filter((r) => !r.label.includes("(revoked"));
  const seen = new Set<string>();
  if (usageCountersEnabled()) {
    const weeks = await Promise.all(recentWeeks(CLIENT_WEEKS).map((w) => readWeekUsage(w, 50)));
    for (const w of weeks) for (const c of w.clients) if (c.count > 0) seen.add(c.name);
  }
  const inUse = active.filter((r) => r.kind === "oauth" || r.lastSeenAt !== null).length;
  return {
    connected: Math.max(inUse, seen.size),
    devices: active.filter((r) => r.kind !== "oauth").length,
    oauth: active.filter((r) => r.kind === "oauth").length,
    lastActivity: latest(active.map((r) => r.lastSeenAt)),
    list: active.map((r) => ({
      label: r.label,
      kind: r.kind === "oauth" ? "oauth" : "token",
      lastSeenAt: r.lastSeenAt,
    })),
    seen: [...seen].sort(),
  };
}

async function notesPart(): Promise<HubSummary["notes"]> {
  const backend = getVaultBackend();
  const stats = await withTimeout(backend.stats(), NOTES_TIMEOUT_MS, "Notes count");
  return { count: stats.totalNotes, backend: backend.kind };
}

async function adminKeyPart(): Promise<string | null> {
  const raw = await getContextKVStore().get(ADMIN_TOKEN_MCP_LAST_KEY);
  const v = (raw ?? "").trim();
  return v && !Number.isNaN(Date.parse(v)) ? v : null;
}

async function setupPart(): Promise<HubSummary["setup"]> {
  // Admin requests carry no caller profile: this reads the default profile's state.
  const s = await readSetupState();
  return { step: s.step, updatedAt: s.updatedAt || null };
}

async function kebabSkillPart(): Promise<string | null> {
  const v = ((await getContextKVStore().get(KEBAB_SKILL_ADDED_KEY)) ?? "").trim();
  return v && !Number.isNaN(Date.parse(v)) ? v : null;
}

async function getHandler(): Promise<Response> {
  const errors: string[] = [];
  const [profile, skills, clients, notes, adminKeyUsedAt, setup, kebabSkillAddedAt] =
    await Promise.all([
      settle("profile", errors, profilePart),
      settle("skills", errors, skillsPart),
      settle("clients", errors, clientsPart),
      settle("notes", errors, notesPart),
      settle("admin key", errors, adminKeyPart),
      settle("setup", errors, setupPart),
      settle("Kebab House skill", errors, kebabSkillPart),
    ]);
  const body: HubSummary = {
    profile,
    skills,
    clients,
    notes,
    adminKeyUsedAt,
    setup,
    kebabSkillAddedAt,
    errors,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/config/hub {"mark": "kebab-skill"} — records that the owner
 * added the Kebab House skill (checklist item). Idempotent: the first
 * time is kept.
 */
async function postHandler(ctx: PipelineContext): Promise<Response> {
  let mark: unknown = null;
  try {
    mark = ((await ctx.request.json()) as { mark?: unknown } | null)?.mark;
  } catch {
    // fall through to the 400 below
  }
  if (mark !== "kebab-skill") {
    return NextResponse.json({ ok: false, error: "unknown_mark" }, { status: 400 });
  }
  const existing = await kebabSkillPart();
  const at = existing ?? new Date().toISOString();
  if (!existing) await getContextKVStore().set(KEBAB_SKILL_ADDED_KEY, at);
  return NextResponse.json({ ok: true, kebabSkillAddedAt: at });
}

export const GET = withAdminAuth(getHandler);
export const POST = withAdminAuth(postHandler);
