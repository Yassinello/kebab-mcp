import { getInstanceConfig } from "@/core/config";
import { isPublicUrl } from "@/core/url-safety";
import { Stagehand } from "@browserbasehq/stagehand";
import Browserbase from "@browserbasehq/sdk";
import { getConfig } from "@/core/config-facade";
import { getRequiredEnv } from "@/core/env-utils";
import { toMsg } from "@/core/error-utils";

export function sanitizeError(err: unknown): string {
  const msg = toMsg(err);
  // Strip anything that looks like an API key or env var value
  const cleaned = msg
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "sk-***")
    .replace(/bb_live_[a-zA-Z0-9]+/g, "bb_***")
    .replace(/ghp_[a-zA-Z0-9]+/g, "ghp_***")
    .replace(/eyJ[a-zA-Z0-9_-]{50,}/g, "***token***");
  return cleaned.slice(0, 300);
}

const ALLOWED_CONTEXTS = new Set(["default", "linkedin"]);

export function validateContextName(name: string): string {
  const normalized = name.toLowerCase();
  if (!ALLOWED_CONTEXTS.has(normalized)) {
    throw new Error(`Invalid context_name '${name}'. Allowed: ${[...ALLOWED_CONTEXTS].join(", ")}`);
  }
  return normalized;
}

/**
 * Phase 44 SCM-05: delegates to the shared SSRF guard in src/core/url-safety.
 *
 * Now async + DNS-resolving: every caller (web-browse, web-extract, web-act,
 * web-agent, web-observe, extract-links) runs inside an async tool handler,
 * so awaiting the DNS lookup costs nothing structurally. The prior sync
 * `isPublicUrlSync` only did a syntactic check — a public hostname whose
 * A/AAAA record resolved to a private / link-local / cloud-metadata address
 * passed straight through (DNS-rebind). `resolveDns: true` validates each
 * resolved record and fails closed on lookup error.
 */
export async function validatePublicUrl(url: string): Promise<void> {
  const result = await isPublicUrl(url, { resolveDns: true });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

// Lazy-init to avoid crashing at build time when env vars aren't set
let bb: Browserbase | null = null;
function getBrowserbase(): Browserbase {
  if (!bb) {
    bb = new Browserbase({ apiKey: getRequiredEnv("BROWSERBASE_API_KEY", "browser") });
  }
  return bb;
}

// In-memory cache for context IDs (survives within a single instance)
const contextCache: Record<string, string> = {};

async function getOrCreateContext(name: string): Promise<string> {
  // Check in-memory cache
  if (contextCache[name]) return contextCache[name];

  // Check env var for persistent context IDs (survives cold starts)
  const envKey = `BROWSERBASE_CONTEXT_${name.toUpperCase()}`;
  const envId = getConfig(envKey);
  if (envId) {
    contextCache[name] = envId;
    return envId;
  }

  // Create a new context via Browserbase SDK
  const context = await getBrowserbase().contexts.create({
    projectId: getRequiredEnv("BROWSERBASE_PROJECT_ID", "browser"),
  });
  contextCache[name] = context.id;
  return context.id;
}

const RATE_LIMIT_PATH = "System/linkedin-rate-limit.json";

interface RateLimitData {
  date: string; // YYYY-MM-DD
  count: number;
}

/**
 * Check and increment a daily counter stored in the GitHub vault.
 * Returns the count BEFORE incrementing.
 * Resets automatically each day (Paris timezone).
 */
export async function checkAndIncrementDailyLimit(
  limit: number
): Promise<{ allowed: boolean; count: number }> {
  const repo = getRequiredEnv("GITHUB_REPO", "browser");
  const pat = getRequiredEnv("GITHUB_PAT", "browser");
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: getInstanceConfig().timezone,
  }); // YYYY-MM-DD

  // Read current counter
  let data: RateLimitData = { date: today, count: 0 };
  let sha: string | undefined;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${RATE_LIMIT_PATH}`, {
      headers: { Authorization: `token ${pat}` },
    });
    if (res.ok) {
      const file = (await res.json()) as { content: string; sha: string };
      sha = file.sha;
      data = JSON.parse(Buffer.from(file.content, "base64").toString("utf-8"));
      // Reset if it's a new day
      if (data.date !== today) {
        data = { date: today, count: 0 };
      }
    }
  } catch {
    // File doesn't exist yet or read error — start fresh
  }

  if (data.count >= limit) {
    return { allowed: false, count: data.count };
  }

  // Increment and write back
  data.count += 1;
  const content = Buffer.from(JSON.stringify(data)).toString("base64");
  try {
    await fetch(`https://api.github.com/repos/${repo}/contents/${RATE_LIMIT_PATH}`, {
      method: "PUT",
      headers: {
        Authorization: `token ${pat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `linkedin_feed call ${data.count}/${limit} — ${today} via Kebab MCP`,
        content,
        ...(sha && { sha }),
      }),
    });
  } catch {
    // Write failed — allow the call anyway (fail open)
  }

  return { allowed: true, count: data.count };
}

export async function createBrowserSession(contextName = "default"): Promise<Stagehand> {
  const contextId = await getOrCreateContext(contextName);

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: getRequiredEnv("BROWSERBASE_API_KEY", "browser"),
    projectId: getRequiredEnv("BROWSERBASE_PROJECT_ID", "browser"),
    browserbaseSessionCreateParams: {
      browserSettings: {
        context: {
          id: contextId,
          persist: true,
        },
      },
    },
    // LLM via OpenRouter (OPENROUTER_API_KEY env var)
    model: {
      modelName: "openai/gpt-4o",
      apiKey: getRequiredEnv("OPENROUTER_API_KEY", "browser"),
      baseURL: "https://openrouter.ai/api/v1",
    },
    disableAPI: true,
    disablePino: true,
    verbose: 0,
  });

  await stagehand.init();
  return stagehand;
}
