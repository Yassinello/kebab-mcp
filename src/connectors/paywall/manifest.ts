import { defineTool, type ConnectorManifest, type ToolDefinition } from "@/core/types";
import { SOURCES, hasAtLeastOneSource } from "./sources";
import { readPaywalledSchema, handleReadPaywalled } from "./tools/read-paywalled";
import {
  readPaywalledHardSchema,
  handleReadPaywalledHard,
  isBrowserPackConfigured,
} from "./tools/read-paywalled-hard";

// Build a markdown guide from the source registry so /config always stays
// in sync with the registered sources.
function buildGuide(): string {
  const blocks = SOURCES.map((s) => {
    return [
      `### ${s.displayName}`,
      `**Env var:** \`${s.cookieEnvVar}\` · **Cookie:** \`${s.cookieName}\` · **Lifetime:** ${s.cookieLifetime}`,
      "",
      s.howToGetCookie,
    ].join("\n");
  });
  return [
    "The Paywall pack activates as soon as **at least one** source cookie is configured.",
    "Each source uses a long-lived session cookie copied from your logged-in browser.",
    "",
    ...blocks,
  ].join("\n\n");
}

export const paywallConnector: ConnectorManifest = {
  id: "paywall",
  label: "Paywall Readers",
  description:
    "Read paywalled articles (Medium, Substack) by reusing your logged-in browser session cookies.",
  requiredEnvVars: [],
  isActive: (env) => {
    if (hasAtLeastOneSource(env)) {
      return { active: true };
    }
    const envVars = SOURCES.map((s) => s.cookieEnvVar).join(" or ");
    return {
      active: false,
      reason: `no source cookie configured (set ${envVars})`,
    };
  },
  guide: buildGuide(),
  // Lazy getter so isBrowserPackConfigured() is evaluated at registry resolve
  // time, letting hot env edits register read_paywalled_hard without restart.
  get tools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      defineTool({
        name: "read_paywalled",
        description:
          "Read a paywalled article from a supported source (Medium, Substack) and return clean markdown. Uses your stored session cookie to bypass the paywall via a simple HTTP fetch + Readability extraction. Fast and cheap — try this first.",
        schema: readPaywalledSchema,
        handler: async (args) => handleReadPaywalled(args),
        destructive: false,
      }),
    ];
    if (isBrowserPackConfigured()) {
      tools.push(
        defineTool({
          name: "read_paywalled_hard",
          description:
            "Read a paywalled article using a full cloud browser (Browserbase). Use only if `read_paywalled` fails due to JavaScript rendering or anti-bot protection. Slower and consumes Browserbase credits.",
          schema: readPaywalledHardSchema,
          handler: async (args) => handleReadPaywalledHard(args),
          destructive: false,
        })
      );
    }
    return tools;
  },
};
