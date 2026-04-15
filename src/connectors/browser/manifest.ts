import type { ConnectorManifest } from "@/core/types";
import { webBrowseSchema, handleWebBrowse } from "./tools/web-browse";
import { webExtractSchema, handleWebExtract } from "./tools/web-extract";
import { webActSchema, handleWebAct } from "./tools/web-act";
import { linkedinFeedSchema, handleLinkedinFeed } from "./tools/linkedin-feed";

export const browserConnector: ConnectorManifest = {
  id: "browser",
  label: "Browser Automation",
  description: "Cloud browser via Stagehand/Browserbase — browse, extract, act, LinkedIn feed",
  guide: `Drive a real cloud browser (via Stagehand on Browserbase) to browse, extract structured data, and perform actions — powered by an LLM routed through OpenRouter.

### Prerequisites
Two accounts:
1. [Browserbase](https://www.browserbase.com) — hosts the headless Chromium session
2. [OpenRouter](https://openrouter.ai) — provides the LLM that Stagehand uses to plan actions

### How to get credentials
1. Sign up at [browserbase.com](https://www.browserbase.com), open **Settings → API Keys**, and copy the key into \`BROWSERBASE_API_KEY\`
2. In the same dashboard, copy your **Project ID** into \`BROWSERBASE_PROJECT_ID\`
3. Sign up at [openrouter.ai](https://openrouter.ai/keys), create an API key, and set it as \`OPENROUTER_API_KEY\`
4. Add a few dollars of credit to OpenRouter — Stagehand planning is cheap but not free

### Troubleshooting
- _Session quota exceeded_: Browserbase free tier caps concurrent sessions; upgrade or wait.
- _Stagehand cannot find element_: the page may be behind login — use \`web_act\` first to sign in, or provide a saved context.
- _Model errors_: verify OpenRouter has credits and the configured model is available.`,
  requiredEnvVars: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "OPENROUTER_API_KEY"],
  testConnection: async (credentials) => {
    const bbKey = credentials.BROWSERBASE_API_KEY;
    if (!bbKey) return { ok: false, message: "Missing Browserbase API key" };
    return { ok: true, message: "Credentials provided — will be verified on first use" };
  },
  tools: [
    {
      name: "web_browse",
      description:
        "Open a URL in a cloud browser and return the visible text content. Handles JavaScript-rendered pages, login-protected pages (if session exists), and dynamic content. Use scroll_count to load more content.",
      schema: webBrowseSchema,
      handler: async (params) =>
        handleWebBrowse(params as { url: string; scroll_count?: number; context_name?: string }),
      destructive: false,
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
      destructive: false,
    },
    {
      name: "web_act",
      description:
        "Open a URL and perform actions in the browser using natural language commands. Each action is executed sequentially. DANGEROUS: can click buttons, fill forms, submit data. The calling agent should always ask user confirmation before invoking this tool.",
      schema: webActSchema,
      handler: async (params) =>
        handleWebAct(params as { url: string; actions: string[]; context_name?: string }),
      destructive: true,
    },
    {
      name: "linkedin_feed",
      description:
        "Read your LinkedIn feed. Returns recent posts with author, content text, engagement metrics (likes, comments), and relative date. Automatically uses saved LinkedIn session. Rate limited to 3 calls per day.",
      schema: linkedinFeedSchema,
      handler: async (params) => handleLinkedinFeed(params as { max_posts?: number }),
      destructive: false,
    },
  ],
};
