import { defineTool, type ConnectorManifest } from "@/core/types";
import {
  myContextSchema,
  handleMyContext,
  myContextUpdateSchema,
  handleMyContextUpdate,
} from "./tools/my-context";
import {
  handleKebabSetup,
  handleSkillTemplateInstall,
  handleSkillTemplatesList,
  kebabSetupSchema,
  skillTemplateInstallSchema,
  skillTemplatesListSchema,
} from "./tools/setup";
import { SETUP_PHRASE } from "@/core/client-links";

/**
 * Kebab House phase 0 (CTX-01) — the personal profile, always available.
 *
 * Core connector: loaded on every instance (no credentials needed) and
 * exempt from per-token connector scopes like `skills`, because the
 * profile served is already chosen per token (device `profile`).
 */
export const contextConnector: ConnectorManifest = {
  id: "context",
  label: "Profile",
  description: "Your personal profile (who you are, current projects, preferences), one per hat.",
  requiredEnvVars: [],
  core: true,
  tools: [
    defineTool({
      name: "my_context",
      description:
        "Get the user's personal profile: role, current projects, priorities, preferences, how they like answers. " +
        "Call it at the start of any personal or work task so you don't ask what you could already know. " +
        "Each client token can be bound to its own profile (one per 'hat').",
      schema: myContextSchema,
      handler: async () => handleMyContext(),
      destructive: false,
    }),
    defineTool({
      name: "my_context_update",
      description:
        "Update the user's personal profile (the one returned by my_context). Only call it when the user asks you to " +
        "remember something about themselves, or after they validated a proposed profile. mode=append adds a section; " +
        "mode=replace rewrites the whole profile.",
      schema: myContextUpdateSchema,
      handler: async (args) => handleMyContextUpdate(args),
      destructive: true,
    }),
    // Kebab House phase 1 (ONB-02..05) — guided setup from the AI client.
    defineTool({
      name: "kebab_setup",
      title: "Set up Kebab House",
      description:
        "Set up or personalise Kebab House (the user's personal AI hub): interview, profile, ritual skills, connectors. " +
        `Call it when the user says "${SETUP_PHRASE}", asks to configure or personalise their assistant/hub, or when my_context reports no profile. ` +
        "It returns the current step and exactly what to do; call it again with action=complete to move on.",
      schema: kebabSetupSchema,
      handler: async (args) => handleKebabSetup(args),
      destructive: false,
      openWorld: false,
    }),
    defineTool({
      name: "skill_templates_list",
      title: "List ritual templates",
      description:
        "List the ritual skill templates that ship with Kebab House (morning brief, meeting prep, remember, weekly review, read later) and whether each is installed.",
      schema: skillTemplatesListSchema,
      handler: async () => handleSkillTemplatesList(),
      destructive: false,
      openWorld: false,
    }),
    defineTool({
      name: "skill_template_install",
      title: "Install a ritual template",
      description:
        "Install (or update) one ritual skill template into the user's skills library. Only after the user agreed to it.",
      schema: skillTemplateInstallSchema,
      handler: async (args) => handleSkillTemplateInstall(args),
      destructive: true,
      openWorld: false,
    }),
  ],
  // ONB-07: for clients that read server instructions (Claude Code, ChatGPT, Codex).
  instructions: () =>
    `Kebab House holds the user's profile (my_context) and personal skills. If the user says "${SETUP_PHRASE}" or my_context reports no profile, call kebab_setup and follow its steps.`,
  // ONB-02: the same guided setup as an MCP prompt (slash command in Claude Desktop / Claude Code).
  registerPrompts: (serverUnknown) => {
    const server = serverUnknown as {
      registerPrompt: (
        name: string,
        config: { title?: string; description: string },
        handler: () => Promise<{
          messages: { role: "user"; content: { type: "text"; text: string } }[];
        }>
      ) => void;
    };
    server.registerPrompt(
      "setup",
      {
        title: "Set up Kebab House",
        description: "Guided setup: interview, profile, rituals, connectors.",
      },
      async () => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `${SETUP_PHRASE}. Call kebab_setup and guide me through each step.`,
            },
          },
        ],
      })
    );
  },
};
