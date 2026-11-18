import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getContextKVStore, getRequestOrigin } from "@/core/request-context";
import { getCallerMeta } from "@/core/token-scope";
import { DEFAULT_PROFILE, listProfiles } from "@/core/profiles";
import { getPublicOrigin } from "@/core/approvals";
import { toMsg } from "@/core/error-utils";
import { installSkillTemplate, templateCatalog } from "@/connectors/skills/lib/templates";
import { listConnectorStatuses, type ConnectorStatus } from "@/core/config-proposals";
import { readActiveProfile } from "./my-context";

/**
 * Kebab House phase 1 (ONB-02..06) — conversational onboarding.
 *
 * The model drives the conversation; `kebab_setup` tells it what the
 * current step is and exactly what to do. State lives in KV so a setup can
 * be resumed in another conversation or another client.
 *
 * Steps: interview → profile → rituals → connectors → skill → done.
 * ("skill" was added after "connectors": saved states keep working, an
 * instance already at "done" stays done.)
 *
 * The state is kept per profile ("hat"): a client bound to another profile
 * runs its own setup instead of being told that the default profile's setup
 * is complete. The default profile keeps the historical key.
 */

export const SETUP_STEPS = [
  "interview",
  "profile",
  "rituals",
  "connectors",
  "skill",
  "done",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

const STATE_KEY = "onboarding:state";

/** KV key of the onboarding state for a bound profile (default: the caller's). */
export function setupStateKey(profile: string | null = getCallerMeta()?.profile ?? null): string {
  return profile && profile !== DEFAULT_PROFILE ? `${STATE_KEY}:${profile}` : STATE_KEY;
}

interface SetupState {
  step: SetupStep;
  updatedAt: string;
  /** Ids of the connectors that were active at the last call (to report newly connected ones). */
  activeConnectors?: string[];
}

export async function readSetupState(): Promise<SetupState> {
  const raw = await getContextKVStore().get(setupStateKey());
  if (raw) {
    try {
      const s = JSON.parse(raw) as Partial<SetupState>;
      if (s.step && (SETUP_STEPS as readonly string[]).includes(s.step)) {
        return {
          step: s.step,
          updatedAt: s.updatedAt ?? "",
          ...(Array.isArray(s.activeConnectors)
            ? { activeConnectors: s.activeConnectors.filter((c) => typeof c === "string") }
            : {}),
        };
      }
    } catch {
      // fall through to a fresh state
    }
  }
  return { step: "interview", updatedAt: "" };
}

export async function writeSetupState(
  step: SetupStep,
  activeConnectors?: string[] | undefined
): Promise<void> {
  const state: SetupState = {
    step,
    updatedAt: new Date().toISOString(),
    ...(activeConnectors ? { activeConnectors } : {}),
  };
  await getContextKVStore().set(setupStateKey(), JSON.stringify(state));
}

function nextStep(step: SetupStep): SetupStep {
  const i = SETUP_STEPS.indexOf(step);
  return SETUP_STEPS[Math.min(i + 1, SETUP_STEPS.length - 1)]!;
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

/**
 * Absolute link to a dashboard page (contract 5). The model does not know
 * the instance URL, so it comes from the incoming request, or (outside a
 * request) from the configured public URL. It carries no credential: the
 * owner signs in as usual.
 */
export function dashboardLink(
  tab: "connectors" | "profile" | "devices" | "skills",
  extra: { connector?: string; panel?: string } = {}
): string {
  const origin = getRequestOrigin() ?? getPublicOrigin();
  const query = new URLSearchParams({ tab });
  for (const [k, v] of Object.entries(extra)) if (v) query.set(k, v);
  return `${origin}/config?${query.toString()}`;
}

/**
 * Whether this client may save the profile and install rituals
 * (my_context_update / skill_template_install are "memory" writes).
 * Read-only clients do not have those tools at all.
 */
function canWriteMemory(): boolean {
  // `access` is the device access level ("read" | "memory" | "full") when the
  // transport provides it; older callers only carry `writeAllowed`.
  const meta = getCallerMeta();
  if (!meta) return true;
  if (typeof meta.access === "string") return meta.access === "memory" || meta.access === "full";
  return meta.writeAllowed;
}

function readOnlyNote(what: string): string {
  return [
    `IMPORTANT: this client cannot ${what}: my_context_update and skill_template_install are not in its tools (it was connected with read-only access).`,
    "Do NOT say anything was saved or installed. Tell the user plainly, and how to allow it:",
    `- reconnect this client to Kebab House and choose "Read + my profile and notes" on the approval page, or`,
    `- open Devices in their dashboard (${dashboardLink("devices")}) and change this client's access level.`,
  ].join("\n");
}

async function profileGuidance(profileName: string): Promise<string> {
  const hats = (await listProfiles()).map((p) => p.name).join(", ");
  let existing: string;
  try {
    const p = await readActiveProfile();
    const where = p.mode === "vault" ? ` (stored as the note "${p.path}" in the user's vault)` : "";
    existing = p.content.trim()
      ? `A profile already exists${where}. Read it with my_context, keep what is still true and propose changes; never replace it with something shorter without the user's agreement.`
      : p.mode === "vault"
        ? `No profile yet. It will be saved as the note "${p.path}" in the user's vault.`
        : "No profile exists yet.";
  } catch (err) {
    existing = `The current profile could not be read (${toMsg(err)}). Do not overwrite it: ask the user to check it in their dashboard first.`;
  }
  const lines = [
    "STEP 2/5 — Profile.",
    existing,
    "Do not start from zero if you already know the user: first draft the profile from what you already know about them (your own memory, earlier conversations, this conversation) plus the interview answers.",
    'Keep it concise Markdown (under ~400 words) with the headings "Role", "Current projects", "Recurring tasks", "Preferences", "Never".',
    "Show the draft to the user and ask for corrections. Only once they approve it, save it with my_context_update (mode: replace).",
    `This client writes to the profile "${profileName}". Existing profiles: ${hats}.`,
    `If the user wears several hats (e.g. personal and a company), tell them to add one profile per hat on the Profile page of their dashboard (${dashboardLink("profile")}) and to choose which profile each client uses in Devices. Do not try to create other profiles yourself.`,
  ];
  if (!canWriteMemory()) {
    lines.push(
      readOnlyNote("save the profile"),
      "Give the user the approved profile text so they can paste it on the Profile page of their dashboard."
    );
  }
  lines.push('Then call kebab_setup with action "complete" and step "profile".');
  return lines.join("\n");
}

async function guidance(step: SetupStep, connectors: ConnectorStatus[] | null): Promise<string> {
  const bound = getCallerMeta()?.profile ?? null;
  const profileName = bound ?? DEFAULT_PROFILE;
  switch (step) {
    case "interview":
      return [
        "STEP 1/5 — Interview (Kebab House setup).",
        "Goal: learn enough about the user to write their profile.",
        "If you already know the user (your own memory of them, earlier conversations), start by saying in two or three lines what you know, and only ask what is missing.",
        "Otherwise ask these questions in ONE short message, in the user's language, and wait for the answers:",
        "1. Your role and what you work on right now (2-3 active projects).",
        "2. The 'hats' you wear (e.g. personal, a company, a side project): each hat can have its own profile.",
        "3. The tasks that come back every week (planning, meeting prep, writing, reading…).",
        "4. How you like answers (language, length, tone) and anything an assistant should never do.",
        'When you have the answers, call kebab_setup with action "complete" and step "interview".',
      ].join("\n");
    case "profile":
      return profileGuidance(profileName);
    case "rituals": {
      const catalog = await templateCatalog();
      const lines = catalog.map(
        (t) => `- ${t.name} (${t.status}): ${t.summary} The user says: "${t.example}".`
      );
      const out = [
        "STEP 3/5 — Rituals.",
        "These ritual templates are available. Using the profile, recommend the 2-4 that match the user's recurring tasks, explain each in one line with the phrase that starts it, and install the ones they accept with skill_template_install:",
        ...lines,
      ];
      if (!canWriteMemory()) out.push(readOnlyNote("install rituals"));
      out.push('Then call kebab_setup with action "complete" and step "rituals".');
      return out.join("\n");
    }
    case "connectors":
      return connectorsGuidance(connectors);
    case "skill":
      return skillGuidance();
    case "done": {
      const installed = (await templateCatalog()).filter((t) => t.installed);
      const first = installed[0];
      return [
        "Setup is complete.",
        installed.length
          ? `Installed rituals and the phrase that starts each: ${installed.map((t) => `${t.title} ("${t.example}")`).join(", ")}.`
          : "No ritual is installed yet: the user can say 'set up my Kebab House' again to pick some.",
        "Also tell the user, in one short line each:",
        `- Another AI client (ChatGPT, Claude Code, a phone…) can use the same Kebab House: add it from Devices in the dashboard (${dashboardLink("devices")}).`,
        '- Each week, "weekly recap" shows what they did with Kebab House (kebab_weekly_recap).',
        "- You can change their settings for them with kebab_config (name, time zone, a client's access, tools on or off): they confirm each change in their browser.",
        first
          ? `End by trying one ritual now, in one short line, e.g.: Try it: say "${first.example}". If the user says it (or just yes), load that skill with skill_load and run it right away.`
          : "End by telling the user, in one short line, what to try first.",
        "They can say 'set up my Kebab House' again at any time to revisit a step.",
      ].join("\n");
    }
  }
}

/** Connectors that need setup, with their deep link; the active ones by name. */
function connectorsGuidance(connectors: ConnectorStatus[] | null): string {
  const out = [
    "STEP 4/5 — Connectors (optional).",
    "Never ask the user to paste a password, token or API key in this conversation: they enter credentials themselves in their dashboard, then come back here.",
    "Gmail, Calendar, Drive, Slack and Notion usually exist as native connectors in the AI client: recommend those first.",
    "Kebab House adds what native connectors lack: LinkedIn and WhatsApp (Unipile, paid), a browser (Browserbase), paywalled articles, Apify scrapers, a notes vault (built in, or an Obsidian repo on GitHub).",
  ];
  if (connectors) {
    const active = connectors.filter((c) => c.status === "active");
    const todo = connectors.filter((c) => c.status === "needs_setup");
    out.push(`Active now: ${active.length ? active.map((c) => c.label).join(", ") : "none"}.`);
    if (todo.length) {
      out.push(
        "Need setup (offer only the ones that fit the user's profile; give the link of the one they pick, it opens its form in their dashboard, where they sign in):",
        ...todo.map((c) => `- ${c.label}: ${dashboardLink("connectors", { connector: c.id })}`)
      );
    }
  } else {
    out.push(
      `If the user wants one, give them this link to their Kebab House dashboard: ${dashboardLink("connectors")} . They sign in there and paste the credentials themselves.`
    );
  }
  out.push(
    'When the user says they are done in the dashboard, call kebab_setup again (action "status"): it reports what is now connected.',
    'Then call kebab_setup with action "complete" and step "connectors".'
  );
  return out.join("\n");
}

type ClientKind = "claude-code" | "claude-app" | "other";

/** Best guess of the AI client from its device label (OAuth clients carry their own name). */
function clientKind(): ClientKind {
  const label = (getCallerMeta()?.label ?? "").toLowerCase();
  if (/claude[\s_-]*code/.test(label)) return "claude-code";
  if (label.includes("claude")) return "claude-app";
  return "other";
}

function skillGuidance(): string {
  const link = dashboardLink("skills", { panel: "kebab-skill" });
  const app = `In claude.ai or Claude Desktop: download the skill from ${link} , then open Settings → Capabilities → Skills → Upload and choose the downloaded zip.`;
  const code = `In Claude Code: download the same zip from ${link} and unzip it into ~/.claude/skills/ (it creates ~/.claude/skills/kebab-house/).`;
  const kind = clientKind();
  const how =
    kind === "claude-code"
      ? [code]
      : kind === "claude-app"
        ? [app, `If they also use Claude Code: ${code.slice("In Claude Code: ".length)}`]
        : [app, code, "If this client has no skills feature, skip this step."];
  return [
    "STEP 5/5 — The Kebab House skill (optional, can be skipped).",
    "In clients that support skills, the Kebab House skill makes the user's skills and rituals start on their own and reminds the assistant how to use Kebab House.",
    ...how,
    "If the user does not want it, skip it.",
    'Then call kebab_setup with action "complete" and step "skill".',
  ].join("\n");
}

/** Steps that report connector changes (from the connectors step on). */
const CONNECTOR_AWARE: readonly SetupStep[] = ["connectors", "skill", "done"];

export const kebabSetupSchema = {
  action: z
    .enum(["status", "complete", "goto", "reset"])
    .optional()
    .describe(
      "status (default): current step and instructions. complete: mark `step` done and get the next one. goto: jump to `step`. reset: start over."
    ),
  step: z.enum(SETUP_STEPS).optional().describe("The step concerned by complete / goto."),
};

export async function handleKebabSetup(args: {
  action?: "status" | "complete" | "goto" | "reset" | undefined;
  step?: SetupStep | undefined;
}): Promise<ToolResult> {
  const action = args.action ?? "status";
  const saved = await readSetupState();
  let step = saved.step;
  if (action === "reset") {
    step = "interview";
  } else if (action === "goto") {
    if (!args.step) {
      return text(
        'goto needs a `step` ("interview", "profile", "rituals", "connectors", "skill" or "done").'
      );
    }
    step = args.step;
  } else if (action === "complete") {
    const next = nextStep(args.step ?? saved.step);
    // Completing an earlier step never moves the state backwards.
    step = SETUP_STEPS.indexOf(next) > SETUP_STEPS.indexOf(saved.step) ? next : saved.step;
  }

  // From the connectors step on: compare the active connectors with the
  // last call, so a connector set up in the dashboard meanwhile is reported.
  let connectors: ConnectorStatus[] | null = null;
  let active = action === "reset" ? undefined : saved.activeConnectors;
  let newly: ConnectorStatus[] = [];
  if (CONNECTOR_AWARE.includes(step)) {
    connectors = await listConnectorStatuses().catch(() => null);
    if (connectors) {
      const now = connectors.filter((c) => c.status === "active");
      if (saved.activeConnectors) {
        const before = new Set(saved.activeConnectors);
        newly = now.filter((c) => !before.has(c.id));
      }
      active = now.map((c) => c.id);
    }
  }
  const changed =
    action !== "status" ||
    step !== saved.step ||
    JSON.stringify(active) !== JSON.stringify(saved.activeConnectors);
  if (changed) await writeSetupState(step, active);

  const body = await guidance(step, connectors);
  if (!newly.length) return text(body);
  return text(
    [
      `Newly connected since the last check, tell the user: ${newly.map((c) => `"${c.label} is connected ✓"`).join(", ")}.`,
      "",
      body,
    ].join("\n")
  );
}

export const skillTemplatesListSchema = {};

export async function handleSkillTemplatesList(): Promise<ToolResult> {
  const catalog = await templateCatalog();
  return text(
    JSON.stringify(
      {
        templates: catalog.map((t) => ({
          name: t.name,
          title: t.title,
          summary: t.summary,
          example: t.example,
          description: t.description,
          status: t.status,
        })),
        usage: "Install one with skill_template_install { name }.",
      },
      null,
      2
    )
  );
}

export const skillTemplateInstallSchema = {
  name: z
    .string()
    .min(1)
    .max(100)
    .describe("Template name from skill_templates_list, e.g. 'morning-brief'."),
};

export async function handleSkillTemplateInstall(args: { name: string }): Promise<ToolResult> {
  const r = await installSkillTemplate(args.name);
  if (!r.ok) {
    return { content: [{ type: "text", text: JSON.stringify({ error: r.error }) }], isError: true };
  }
  const verb = r.action === "unchanged" ? "already installed" : r.action;
  return text(`Skill "${r.name}" ${verb}. Load it with skill_load { name: "${r.name}" }.`);
}
