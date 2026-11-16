import { defineTool, type ConnectorManifest } from "@/core/types";
import type { ResourceProvider, ResourceSpec } from "@/core/resources";
import { UI_MIME_TYPE, UI_SCHEME, UI_URI_PREFIX, uiToolMeta } from "./views/bridge";
import { STATUS_VIEW } from "./views/status";
import { GALLERY_VIEW } from "./views/gallery";
import { approveView } from "./views/approve";
import { getRequestOrigin } from "@/core/request-context";
import { getPublicOrigin } from "@/core/approvals";
import {
  handleKebabStatus,
  handleSkillsGallery,
  handleWeeklyRecap,
  kebabStatusSchema,
  skillsGallerySchema,
  weeklyRecapSchema,
} from "./tools/house-tools";

/**
 * Kebab House phase 3 (APP-01..12, RCP-01) — the hub made visible.
 *
 * Core connector: views (MCP Apps, `ui://kebab-house/<view>`) and the
 * tools they render. Clients that do not render MCP Apps get the complete
 * Markdown text of every result.
 */

/** Origins an approval link may point to: this request's, and the one approval links are built with. */
function instanceOrigins(): string[] {
  return [getRequestOrigin(), getPublicOrigin()].filter((o): o is string => Boolean(o));
}

const VIEWS: Record<string, { name: string; description: string; html: () => string }> = {
  status: {
    name: "Kebab House status",
    description: "Profile, skills, connectors and this week's usage.",
    html: () => STATUS_VIEW,
  },
  gallery: {
    name: "Skills gallery",
    description: "Your skills and the ritual templates.",
    html: () => GALLERY_VIEW,
  },
  approve: {
    name: "Review before sending",
    description: "Preview of an outgoing message, with the approval link.",
    html: () => approveView(instanceOrigins()),
  },
};

export const uiResources: ResourceProvider = {
  scheme: UI_SCHEME,
  async list(): Promise<ResourceSpec[]> {
    return Object.entries(VIEWS).map(([id, v]) => ({
      uri: `${UI_URI_PREFIX}${id}`,
      name: v.name,
      description: v.description,
      mimeType: UI_MIME_TYPE,
    }));
  },
  async read(uri: string) {
    const id = uri.startsWith(UI_URI_PREFIX) ? uri.slice(UI_URI_PREFIX.length) : "";
    const view = VIEWS[id];
    if (!view) throw new Error(`unknown view: ${uri}`);
    return { uri, mimeType: UI_MIME_TYPE, text: view.html() };
  },
};

export const houseConnector: ConnectorManifest = {
  id: "house",
  label: "Kebab House views",
  description: "Interactive views (MCP Apps) and the weekly recap.",
  requiredEnvVars: [],
  core: true,
  tools: [
    defineTool({
      name: "kebab_status",
      title: "Kebab House status",
      description:
        "Show the state of the user's Kebab House: active profile, number of skills, recent notes, connectors and this week's usage. Use when the user asks what their hub/assistant knows or has.",
      schema: kebabStatusSchema,
      handler: async () => handleKebabStatus(),
      destructive: false,
      openWorld: false,
      meta: uiToolMeta("status"),
    }),
    defineTool({
      name: "skills_gallery",
      title: "Skills gallery",
      description:
        "Show the user's skills and the ritual templates as a browsable gallery. Use when the user wants to see or pick among their skills.",
      schema: skillsGallerySchema,
      handler: async () => handleSkillsGallery(),
      destructive: false,
      openWorld: false,
      meta: uiToolMeta("gallery"),
    }),
    defineTool({
      name: "kebab_weekly_recap",
      title: "Weekly recap",
      description:
        "Recap of one week of Kebab House use: tool calls, skills used, clients, notes added and changed, compared with the week before. Default: the current week from Friday to Sunday, else the last complete week (the text says which).",
      schema: weeklyRecapSchema,
      handler: async (args) => handleWeeklyRecap(args),
      destructive: false,
      openWorld: false,
    }),
  ],
  resources: uiResources,
};
