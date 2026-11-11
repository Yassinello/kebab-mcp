import { getInstanceConfig } from "@/core/config";
import { isPublicUrl } from "@/core/url-safety";
import { Stagehand } from "@browserbasehq/stagehand";
import Browserbase from "@browserbasehq/sdk";
import { getConfig } from "@/core/config-facade";
import { getContextKVStore } from "@/core/request-context";
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

/**
 * SEC-13 (2026-11 audit): tools that drive the page freely (`web_act`,
 * `web_agent`) must not run inside the logged-in `linkedin` context by
 * default — a prompt-injected page or message could otherwise make the
 * model send messages / connection requests as the user, bypassing every
 * Unipile guard (confirm, rate limits, kill switch, audit). Read-only tools
 * (`linkedin_feed`, extract/observe) keep using the context.
 * KEBAB_BROWSER_LINKEDIN_WRITE=1 lifts the restriction.
 */
export function assertInteractiveContextAllowed(contextName: string): void {
  if (contextName !== "linkedin") return;
  const v = getConfig("KEBAB_BROWSER_LINKEDIN_WRITE");
  if (v === "1" || v === "true") return;
  throw new Error(
    "Interactive browser actions in the 'linkedin' context are disabled: they act as you on " +
      "LinkedIn with none of the Unipile safeguards. Use the Unipile tools, or set " +
      "KEBAB_BROWSER_LINKEDIN_WRITE=1 to allow it."
  );
}

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

/**
 * Check and increment the daily linkedin_feed counter.
 * Returns the count AFTER incrementing (the call being admitted).
 * Resets automatically each day (instance timezone).
 *
 * REL-08 (2026-11 audit): the counter lives in KV (atomic INCR + 48h TTL,
 * tenant-scoped). It used to be a JSON file committed to the Obsidian vault
 * repository on every call: it required the vault connector's GitHub PAT,
 * raced without retry, failed open, and polluted the repo history.
 */
export async function checkAndIncrementDailyLimit(
  limit: number
): Promise<{ allowed: boolean; count: number }> {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: getInstanceConfig().timezone,
  }); // YYYY-MM-DD
  const kv = getContextKVStore();
  const key = `browser:linkedin-feed:count:${today}`;
  let count: number;
  if (typeof kv.incr === "function") {
    count = await kv.incr(key, { ttlSeconds: 48 * 3600 });
  } else {
    count = Number((await kv.get(key)) ?? "0") + 1;
    await kv.set(key, String(count));
  }
  if (count > limit) {
    return { allowed: false, count: count - 1 };
  }
  return { allowed: true, count };
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
