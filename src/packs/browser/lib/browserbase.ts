import { getInstanceConfig } from "@/core/config";
import { Stagehand } from "@browserbasehq/stagehand";
import Browserbase from "@browserbasehq/sdk";

export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
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
    throw new Error(
      `Invalid context_name '${name}'. Allowed: ${[...ALLOWED_CONTEXTS].join(", ")}`
    );
  }
  return normalized;
}

export function validatePublicUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https URLs are allowed");
  }

  const host = parsed.hostname.toLowerCase();

  // Block loopback / localhost
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "[::1]"
  ) {
    throw new Error("Access to localhost is not allowed");
  }

  // Block private IP ranges
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    const [a, b] = parts;
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 169 && b === 254
    ) {
      throw new Error("Access to private networks is not allowed");
    }
  }

  // Block cloud metadata endpoints
  if (host === "metadata.google.internal" || host === "169.254.169.254") {
    throw new Error("Access to cloud metadata is not allowed");
  }
}

// Lazy-init to avoid crashing at build time when env vars aren't set
let bb: Browserbase | null = null;
function getBrowserbase(): Browserbase {
  if (!bb) {
    bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });
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
  const envId = process.env[envKey];
  if (envId) {
    contextCache[name] = envId;
    return envId;
  }

  // Create a new context via Browserbase SDK
  const context = await getBrowserbase().contexts.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
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
  const repo = process.env.GITHUB_REPO!;
  const pat = process.env.GITHUB_PAT!;
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: getInstanceConfig().timezone,
  }); // YYYY-MM-DD

  // Read current counter
  let data: RateLimitData = { date: today, count: 0 };
  let sha: string | undefined;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${RATE_LIMIT_PATH}`,
      { headers: { Authorization: `token ${pat}` } }
    );
    if (res.ok) {
      const file = (await res.json()) as { content: string; sha: string };
      sha = file.sha;
      data = JSON.parse(
        Buffer.from(file.content, "base64").toString("utf-8")
      );
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
    await fetch(
      `https://api.github.com/repos/${repo}/contents/${RATE_LIMIT_PATH}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${pat}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `linkedin_feed call ${data.count}/${limit} — ${today} via MyMCP`,
          content,
          ...(sha && { sha }),
        }),
      }
    );
  } catch {
    // Write failed — allow the call anyway (fail open)
  }

  return { allowed: true, count: data.count };
}

export async function createBrowserSession(
  contextName = "default"
): Promise<Stagehand> {
  const contextId = await getOrCreateContext(contextName);

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY!,
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
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
      apiKey: process.env.OPENROUTER_API_KEY!,
      baseURL: "https://openrouter.ai/api/v1",
    },
    disableAPI: true,
    disablePino: true,
    verbose: 0,
  });

  await stagehand.init();
  return stagehand;
}
