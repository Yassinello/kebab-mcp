import { defineTool, type ConnectorManifest } from "@/core/types";
import {
  webBrowseSchema,
  webExtractSchema,
  webActSchema,
  webObserveSchema,
  webAgentSchema,
  extractLinksSchema,
  linkedinFeedSchema,
} from "./schemas";

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
    const bbProject = credentials.BROWSERBASE_PROJECT_ID;
    const orKey = credentials.OPENROUTER_API_KEY;
    if (!bbKey) return { ok: false, message: "Missing Browserbase API key" };
    if (!bbProject) return { ok: false, message: "Missing Browserbase project ID" };
    if (!orKey) return { ok: false, message: "Missing OpenRouter API key" };

    const [bb, or] = await Promise.all([pingBrowserbase(bbKey, bbProject), pingOpenRouter(orKey)]);
    if (!bb.ok && !or.ok) {
      return { ok: false, message: `Browserbase: ${bb.reason} · OpenRouter: ${or.reason}` };
    }
    if (!bb.ok) return { ok: false, message: `Browserbase: ${bb.reason}` };
    if (!or.ok) return { ok: false, message: `OpenRouter: ${or.reason}` };
    return { ok: true, message: `Browserbase: ${bb.detail} · OpenRouter: ${or.detail}` };
  },
  tools: [
    defineTool({
      name: "web_browse",
      description:
        "Open a URL in a cloud browser and return the visible text content. Handles JavaScript-rendered pages, login-protected pages (if session exists), and dynamic content. Use scroll_count to load more content.",
      schema: webBrowseSchema,
      handler: async (args) => {
        const { handleWebBrowse } = await import("./tools/web-browse");
        return handleWebBrowse(args);
      },
      destructive: false,
    }),
    defineTool({
      name: "web_extract",
      description:
        "Open a URL and extract structured data using AI. Provide a natural language instruction AND (strongly recommended) a JSON Schema constraining the shape — without a schema the LLM may hallucinate fields, especially URLs. Use scroll_count='auto' to wait for infinite-scroll feeds.",
      schema: webExtractSchema,
      handler: async (args) => {
        const { handleWebExtract } = await import("./tools/web-extract");
        return handleWebExtract(args);
      },
      destructive: false,
    }),
    defineTool({
      name: "web_act",
      description:
        "Open a URL and perform actions in the browser using natural language commands. Each action is executed sequentially. DANGEROUS: can click buttons, fill forms, submit data. The calling agent should always ask user confirmation before invoking this tool.",
      schema: webActSchema,
      handler: async (args) => {
        const { handleWebAct } = await import("./tools/web-act");
        return handleWebAct(args);
      },
      destructive: true,
    }),
    defineTool({
      name: "web_observe",
      description:
        "Surface candidate UI elements matching a natural-language description. Returns CSS selectors plus textual descriptions — useful for discovering selectors before web_act, or for low-cost element discovery without a full extract round.",
      schema: webObserveSchema,
      handler: async (args) => {
        const { handleWebObserve } = await import("./tools/web-observe");
        return handleWebObserve(args);
      },
      destructive: false,
    }),
    defineTool({
      name: "web_agent",
      description:
        "Run an autonomous browser agent toward a goal. The agent plans multi-step tool calls (act, extract, observe, navigate) until the instruction is satisfied or max_steps is hit. Use for tasks like 'find the cheapest 2BR in Vincennes and return its title, price, and link'. DANGEROUS: can take real actions on the page.",
      schema: webAgentSchema,
      handler: async (args) => {
        const { handleWebAgent } = await import("./tools/web-agent");
        return handleWebAgent(args);
      },
      destructive: true,
    }),
    defineTool({
      name: "extract_links",
      description:
        "Pull anchor hrefs directly from the DOM — no LLM, so hrefs are guaranteed real (not hallucinated). Optionally filter by CSS selector or href substring/regex. Use this for marketplace listing pages (Vinted, eBay, Le Bon Coin) where you need the actual item URLs.",
      schema: extractLinksSchema,
      handler: async (args) => {
        const { handleExtractLinks } = await import("./tools/extract-links");
        return handleExtractLinks(args);
      },
      destructive: false,
    }),
    defineTool({
      name: "linkedin_feed",
      description:
        "Read your LinkedIn feed. Returns recent posts with author, content text, engagement metrics (likes, comments), and relative date. Automatically uses saved LinkedIn session. Rate limited to 5 calls per day.",
      schema: linkedinFeedSchema,
      handler: async (args) => {
        const { handleLinkedinFeed } = await import("./tools/linkedin-feed");
        return handleLinkedinFeed(args);
      },
      destructive: false,
    }),
  ],
};

type PingResult = { ok: true; detail: string } | { ok: false; reason: string };

async function pingBrowserbase(apiKey: string, projectId: string): Promise<PingResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(
      `https://api.browserbase.com/v1/projects/${encodeURIComponent(projectId)}`,
      { method: "GET", headers: { "X-BB-API-Key": apiKey }, signal: ctrl.signal }
    );
    if (res.status === 401) return { ok: false, reason: "invalid API key" };
    if (res.status === 403) return { ok: false, reason: "key has no access to this project" };
    if (res.status === 404) return { ok: false, reason: "project ID not found" };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { name?: string; concurrency?: number };
    const name = data.name || "project";
    const conc = typeof data.concurrency === "number" ? `, concurrency=${data.concurrency}` : "";
    return { ok: true, detail: `${name}${conc}` };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error && err.name === "AbortError" ? "timeout (5s)" : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function pingOpenRouter(apiKey: string): Promise<PingResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (res.status === 401) return { ok: false, reason: "invalid API key" };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as {
      data?: { label?: string; limit_remaining?: number | null; is_free_tier?: boolean };
    };
    const d = body.data ?? {};
    const tier = d.is_free_tier ? "free tier" : "paid";
    const credit =
      d.limit_remaining == null ? "unlimited" : `$${Number(d.limit_remaining).toFixed(2)} left`;
    const label = d.label ? `${d.label}, ` : "";
    return { ok: true, detail: `${label}${tier}, ${credit}` };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error && err.name === "AbortError" ? "timeout (5s)" : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}
