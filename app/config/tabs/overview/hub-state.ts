/**
 * 2026-11 audit (C1.1) — what the Overview says about the user's hub:
 * the "Getting started" steps and the one next action, computed from
 * GET /api/config/hub. Pure functions, unit-tested.
 */

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
    errors: Array.isArray(d.errors)
      ? (d.errors.filter((e) => typeof e === "string") as string[])
      : [],
  };
}

export const LINKS = {
  connectClient: "/config?tab=settings&sub=mcp",
  profile: "/config?tab=profile",
  skills: "/config?tab=skills",
  devices: "/config?tab=devices",
  memory: "/config?tab=memory",
} as const;

export interface HubStep {
  id: "client" | "profile" | "ritual" | "second-client";
  label: string;
  hint: string;
  href: string;
  done: boolean;
}

/**
 * The four "Getting started" steps. A step whose data is unavailable
 * (that part of the hub failed to load) counts as not done.
 */
export function gettingStartedSteps(hub: HubData): HubStep[] {
  const connected = hub.clients?.connected ?? 0;
  return [
    {
      id: "client",
      label: "Connect an AI client",
      hint: "Add Kebab House to Claude, ChatGPT or another AI app.",
      href: LINKS.connectClient,
      done: connected >= 1,
    },
    {
      id: "profile",
      label: "Create your profile",
      hint: "Say “Set up my Kebab House” in your AI client, or write it here.",
      href: LINKS.profile,
      done: hub.profile?.filled === true,
    },
    {
      id: "ritual",
      label: "Install a ritual",
      hint: "Ready-made skills like a morning brief or a weekly review.",
      href: LINKS.skills,
      done: (hub.skills?.rituals.installed ?? 0) >= 1,
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
  href: string;
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
  if (step) return { label: step.label, href: step.href, why: step.hint };
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
