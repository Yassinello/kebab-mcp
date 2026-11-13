import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getContextKVStore } from "@/core/request-context";
import { getCallerMeta } from "@/core/token-scope";
import { DEFAULT_PROFILE, getProfileContent, listProfiles } from "@/core/profiles";
import { installSkillTemplate, templateCatalog } from "@/connectors/skills/lib/templates";

/**
 * Kebab House phase 1 (ONB-02..06) — conversational onboarding.
 *
 * The model drives the conversation; `kebab_setup` tells it what the
 * current step is and exactly what to do. State lives in KV so a setup can
 * be resumed in another conversation or another client.
 *
 * Steps: interview → profile → rituals → connectors → done.
 */

export const SETUP_STEPS = ["interview", "profile", "rituals", "connectors", "done"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

const STATE_KEY = "onboarding:state";

interface SetupState {
  step: SetupStep;
  updatedAt: string;
}

export async function readSetupState(): Promise<SetupState> {
  const raw = await getContextKVStore().get(STATE_KEY);
  if (raw) {
    try {
      const s = JSON.parse(raw) as Partial<SetupState>;
      if (s.step && (SETUP_STEPS as readonly string[]).includes(s.step)) {
        return { step: s.step, updatedAt: s.updatedAt ?? "" };
      }
    } catch {
      // fall through to a fresh state
    }
  }
  return { step: "interview", updatedAt: "" };
}

export async function writeSetupState(step: SetupStep): Promise<void> {
  const state: SetupState = { step, updatedAt: new Date().toISOString() };
  await getContextKVStore().set(STATE_KEY, JSON.stringify(state));
}

function nextStep(step: SetupStep): SetupStep {
  const i = SETUP_STEPS.indexOf(step);
  return SETUP_STEPS[Math.min(i + 1, SETUP_STEPS.length - 1)]!;
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

/** Where the owner manages connectors. Carries no credential: the owner signs in as usual. */
function dashboardLink(path: string): string {
  return `/config?tab=${path}`;
}

async function guidance(step: SetupStep): Promise<string> {
  const bound = getCallerMeta()?.profile ?? null;
  const profileName = bound ?? DEFAULT_PROFILE;
  switch (step) {
    case "interview":
      return [
        "STEP 1/4 — Interview (Kebab House setup).",
        "Goal: learn enough about the user to write their profile. Ask these questions in ONE short message, in the user's language, and wait for the answers:",
        "1. Your role and what you work on right now (2-3 active projects).",
        "2. The 'hats' you wear (e.g. personal, a company, a side project) — one profile can be created per hat.",
        "3. The tasks that come back every week (planning, meeting prep, writing, reading…).",
        "4. How you like answers (language, length, tone) and anything an assistant should never do.",
        'When you have the answers, call kebab_setup with action "complete" and step "interview".',
      ].join("\n");
    case "profile": {
      const current = (await getProfileContent(profileName)) ?? "";
      const hats = (await listProfiles()).map((p) => p.name).join(", ");
      return [
        "STEP 2/4 — Profile.",
        `Draft a concise Markdown profile (under ~400 words) from the interview: headings "Role", "Current projects", "Recurring tasks", "Preferences", "Never".`,
        "Show the draft to the user and ask for corrections. Only once they approve it, save it with my_context_update (mode: replace).",
        `This client writes to the profile "${profileName}". Existing profiles: ${hats}. Other hats are created in the dashboard (Settings → Other profiles) and bound to a client in Devices.`,
        current.trim()
          ? "A profile already exists: start from it (call my_context) and propose changes rather than starting over."
          : "No profile exists yet.",
        'Then call kebab_setup with action "complete" and step "profile".',
      ].join("\n");
    }
    case "rituals": {
      const catalog = await templateCatalog();
      const lines = catalog.map((t) => `- ${t.name} (${t.status}): ${t.description.slice(0, 160)}`);
      return [
        "STEP 3/4 — Rituals.",
        "These ritual templates are available. Using the profile, recommend the 2-4 that match the user's recurring tasks, explain each in one line, and install the ones they accept with skill_template_install:",
        ...lines,
        "Tip: in clients that ignore server instructions (claude.ai, ChatGPT), the user can download the master relay skill from the dashboard (Skills → Use everywhere) so these skills trigger on their own.",
        'Then call kebab_setup with action "complete" and step "rituals".',
      ].join("\n");
    }
    case "connectors":
      return [
        "STEP 4/4 — Connectors (optional).",
        "Never ask the user to paste a password, token or API key in this conversation.",
        "Gmail, Calendar, Drive, Slack and Notion usually exist as native connectors in the AI client: recommend those first.",
        "Kebab House adds what native connectors lack: LinkedIn and WhatsApp (Unipile, paid), a browser (Browserbase), paywalled articles, Apify scrapers, a GitHub-backed notes vault.",
        `If the user wants one, tell them to open their Kebab House dashboard at ${dashboardLink("connectors")} (relative to their Kebab House URL) and paste the credentials there.`,
        'Then call kebab_setup with action "complete" and step "connectors".',
      ].join("\n");
    case "done":
      return [
        "Setup is complete.",
        "Remind the user of the phrases that trigger their rituals (e.g. 'morning brief', 'remember this', 'prep my meeting with…'), and that they can say 'set up my Kebab House' again at any time to revisit a step.",
      ].join("\n");
  }
}

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
  let state = await readSetupState();
  if (action === "reset") {
    await writeSetupState("interview");
    state = { step: "interview", updatedAt: "" };
  } else if (action === "goto") {
    if (!args.step)
      return text(
        'goto needs a `step` ("interview", "profile", "rituals", "connectors" or "done").'
      );
    await writeSetupState(args.step);
    state = { step: args.step, updatedAt: "" };
  } else if (action === "complete") {
    const done = args.step ?? state.step;
    const next = nextStep(done);
    // Completing an earlier step never moves the state backwards.
    const target = SETUP_STEPS.indexOf(next) > SETUP_STEPS.indexOf(state.step) ? next : state.step;
    await writeSetupState(target);
    state = { step: target, updatedAt: "" };
  }
  return text(await guidance(state.step));
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
