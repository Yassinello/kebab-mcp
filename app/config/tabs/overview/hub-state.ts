/**
 * 2026-11 audit (C1.1) — what the Overview says about the user's hub:
 * the "Getting started" steps and the one next action, computed from
 * GET /api/config/hub. Pure functions, unit-tested.
 */

import { SETUP_PHRASE } from "@/core/client-links";

export interface HubData {
  profile: {
    mode: "inline" | "vault";
    bytes: number;
    updatedAt: string | null;
    by: string | null;
    filled: boolean;
    otherProfiles: number;
  } | null;
  skills: { count: number; rituals: { installed: number; total: number } } | null;
  clients: {
    connected: number;
    devices: number;
    oauth: number;
    lastActivity: string | null;
    list: { label: string; kind: "token" | "oauth"; lastSeenAt: string | null }[];
    seen: string[];
  } | null;
  notes: { count: number; backend: string } | null;
  adminKeyUsedAt: string | null;
  /** Conversational onboarding state (`kebab_setup`); step "done" when finished. */
  setup: { step: string; updatedAt: string | null } | null;
  /** When the owner added the Kebab House skill (download or "I did it"). */
  kebabSkillAddedAt: string | null;
  errors: string[];
}

/** Tolerant parse of the /api/config/hub body (missing parts become null). */
export function parseHub(raw: unknown): HubData {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const obj = <T>(v: unknown): T | null => (v && typeof v === "object" ? (v as T) : null);
  return {
    profile: obj<HubData["profile"]>(d.profile),
    skills: obj<HubData["skills"]>(d.skills),
    clients: obj<HubData["clients"]>(d.clients),
    notes: obj<HubData["notes"]>(d.notes),
    adminKeyUsedAt: typeof d.adminKeyUsedAt === "string" ? d.adminKeyUsedAt : null,
    setup: (() => {
      const s = obj<{ step?: unknown; updatedAt?: unknown }>(d.setup);
      if (!s || typeof s.step !== "string") return null;
      return { step: s.step, updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : null };
    })(),
    kebabSkillAddedAt: typeof d.kebabSkillAddedAt === "string" ? d.kebabSkillAddedAt : null,
    errors: Array.isArray(d.errors)
      ? (d.errors.filter((e) => typeof e === "string") as string[])
      : [],
  };
}

export const LINKS = {
  /** The "Connect Claude" card, shown at the top of the Overview until a client connects. */
  connectClient: "#connect-claude",
  profile: "/config?tab=profile",
  skills: "/config?tab=skills",
  kebabSkill: "/config?tab=skills&panel=kebab-skill",
  devices: "/config?tab=devices",
  memory: "/config?tab=memory",
} as const;

export interface HubStep {
  id: "client" | "setup" | "kebab-skill" | "second-client";
  label: string;
  hint: string;
  /** Where the step is done; absent when it happens in the AI client. */
  href?: string;
  /** Text to copy instead of a link (the setup phrase). */
  copy?: string;
  /** The owner can tick the step by hand (nothing to detect it). */
  manual?: boolean;
  done: boolean;
}

/** True when any AI client (device token or signed-in app) has been seen. */
export function hasConnectedClient(hub: HubData): boolean {
  return (hub.clients?.connected ?? 0) >= 1;
}

/**
 * The "Getting started" steps, in order. A step whose data is unavailable
 * (that part of the hub failed to load) counts as not done.
 */
export function gettingStartedSteps(hub: HubData): HubStep[] {
  const connected = hub.clients?.connected ?? 0;
  return [
    {
      id: "client",
      label: "Connect an AI client",
      hint: "Add Kebab House to Claude, or to ChatGPT, Cursor or another AI app.",
      href: LINKS.connectClient,
      done: connected >= 1,
    },
    {
      id: "setup",
      label: `Say “${SETUP_PHRASE}”`,
      hint: "Claude then interviews you, writes your profile, installs rituals and helps you plug in connectors.",
      copy: SETUP_PHRASE,
      done: hub.setup?.step === "done",
    },
    {
      id: "kebab-skill",
      label: "Add the Kebab House skill",
      hint: "Claude then uses your profile, skills and Kebab House rules on its own.",
      href: LINKS.kebabSkill,
      manual: true,
      done: hub.kebabSkillAddedAt !== null,
    },
    {
      id: "second-client",
      label: "Connect a second AI client",
      hint: "Your profile, skills and notes follow you from one app to the other.",
      href: LINKS.devices,
      done: connected >= 2,
    },
  ];
}

export interface NextAction {
  label: string;
  /** Link to follow; absent when the action is a phrase to copy. */
  href?: string;
  copy?: string;
  why: string;
}

/** The single most useful thing to do next. */
export function nextAction(hub: HubData): NextAction {
  if (hub.adminKeyUsedAt) {
    return {
      label: "Give your AI client its own key",
      href: LINKS.devices,
      why: "An AI client uses your admin key.",
    };
  }
  const step = gettingStartedSteps(hub).find((s) => !s.done);
  if (step) {
    return {
      label: step.label,
      why: step.hint,
      ...(step.href ? { href: step.href } : {}),
      ...(step.copy ? { copy: step.copy } : {}),
    };
  }
  if ((hub.notes?.count ?? 0) === 0) {
    return {
      label: "Open your memory",
      href: LINKS.memory,
      why: "Say “remember that…” in any AI client to save your first note.",
    };
  }
  return {
    label: "Browse your memory",
    href: LINKS.memory,
    why: "See what your AI clients saved for you.",
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
