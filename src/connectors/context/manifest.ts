import { defineTool, type ConnectorManifest } from "@/core/types";
import {
  myContextSchema,
  handleMyContext,
  myContextUpdateSchema,
  handleMyContextUpdate,
} from "./tools/my-context";

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
  ],
};
