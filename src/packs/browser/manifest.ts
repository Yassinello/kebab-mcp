import type { PackManifest } from "@/core/types";
import { webBrowseSchema, handleWebBrowse } from "./tools/web-browse";
import { webExtractSchema, handleWebExtract } from "./tools/web-extract";
import { webActSchema, handleWebAct } from "./tools/web-act";
import { linkedinFeedSchema, handleLinkedinFeed } from "./tools/linkedin-feed";

export const browserPack: PackManifest = {
  id: "browser",
  label: "Browser Automation",
  description: "Cloud browser via Stagehand/Browserbase — browse, extract, act, LinkedIn feed",
  requiredEnvVars: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "OPENROUTER_API_KEY"],
  tools: [
    {
      name: "web_browse",
      description:
        "Open a URL in a cloud browser and return the visible text content. Handles JavaScript-rendered pages, login-protected pages (if session exists), and dynamic content. Use scroll_count to load more content.",
      schema: webBrowseSchema,
      handler: async (params) =>
        handleWebBrowse(params as { url: string; scroll_count?: number; context_name?: string }),
    },
    {
      name: "web_extract",
      description:
        "Open a URL and extract structured data using AI. Provide a natural language instruction describing what to extract. Returns JSON data. Great for: feed posts, competitor pricing, changelogs, news headlines, product features, job listings.",
      schema: webExtractSchema,
      handler: async (params) =>
        handleWebExtract(
          params as {
            url: string;
            instruction: string;
            scroll_count?: number;
            context_name?: string;
          }
        ),
    },
    {
      name: "web_act",
      description:
        "Open a URL and perform actions in the browser using natural language commands. Each action is executed sequentially. DANGEROUS: can click buttons, fill forms, submit data. The calling agent should always ask user confirmation before invoking this tool.",
      schema: webActSchema,
      handler: async (params) =>
        handleWebAct(params as { url: string; actions: string[]; context_name?: string }),
    },
    {
      name: "linkedin_feed",
      description:
        "Read your LinkedIn feed. Returns recent posts with author, content text, engagement metrics (likes, comments), and relative date. Automatically uses saved LinkedIn session. Rate limited to 3 calls per day.",
      schema: linkedinFeedSchema,
      handler: async (params) => handleLinkedinFeed(params as { max_posts?: number }),
    },
  ],
};
