import type { ConnectorManifest, ToolDefinition } from "@/core/types";
import {
  apifyLinkedinProfileSchema,
  handleApifyLinkedinProfile,
  APIFY_LINKEDIN_PROFILE_ACTOR,
} from "./tools/linkedin-profile";
import {
  apifyLinkedinCompanySchema,
  handleApifyLinkedinCompany,
  APIFY_LINKEDIN_COMPANY_ACTOR,
} from "./tools/linkedin-company";
import {
  apifyLinkedinProfilePostsSchema,
  handleApifyLinkedinProfilePosts,
  APIFY_LINKEDIN_PROFILE_POSTS_ACTOR,
} from "./tools/linkedin-profile-posts";
import {
  apifyLinkedinCompanyPostsSchema,
  handleApifyLinkedinCompanyPosts,
  APIFY_LINKEDIN_COMPANY_POSTS_ACTOR,
} from "./tools/linkedin-company-posts";
import {
  apifyLinkedinPostSchema,
  handleApifyLinkedinPost,
  APIFY_LINKEDIN_POST_ACTOR,
} from "./tools/linkedin-post";
import {
  apifyLinkedinCompanyInsightsSchema,
  handleApifyLinkedinCompanyInsights,
  APIFY_LINKEDIN_COMPANY_INSIGHTS_ACTOR,
} from "./tools/linkedin-company-insights";
import { apifySearchActorsSchema, handleApifySearchActors } from "./tools/search-actors";
import { apifyRunActorSchema, handleApifyRunActor } from "./tools/run-actor";

interface WrapperDef {
  actorId: string;
  tool: ToolDefinition;
}

const WRAPPERS: WrapperDef[] = [
  {
    actorId: APIFY_LINKEDIN_PROFILE_ACTOR,
    tool: {
      name: "apify_linkedin_profile",
      description:
        "Scrapes a LinkedIn profile via Apify. Returns structured profile data (name, headline, experience, education, etc.). Takes ~10-30s.",
      schema: apifyLinkedinProfileSchema,
      handler: async (params) => handleApifyLinkedinProfile(params as { url: string }),
      destructive: false,
    },
  },
  {
    actorId: APIFY_LINKEDIN_COMPANY_ACTOR,
    tool: {
      name: "apify_linkedin_company",
      description:
        "Scrapes a LinkedIn company page via Apify. Returns structured company data (name, size, industry, description, website). Takes ~10-30s.",
      schema: apifyLinkedinCompanySchema,
      handler: async (params) => handleApifyLinkedinCompany(params as { url: string }),
      destructive: false,
    },
  },
  {
    actorId: APIFY_LINKEDIN_PROFILE_POSTS_ACTOR,
    tool: {
      name: "apify_linkedin_profile_posts",
      description:
        "Scrapes recent posts from a LinkedIn profile via Apify. Returns an array of posts with text, reactions, and comments. Takes ~10-30s.",
      schema: apifyLinkedinProfilePostsSchema,
      handler: async (params) =>
        handleApifyLinkedinProfilePosts(params as { url: string; maxPosts?: number }),
      destructive: false,
    },
  },
  {
    actorId: APIFY_LINKEDIN_COMPANY_POSTS_ACTOR,
    tool: {
      name: "apify_linkedin_company_posts",
      description:
        "Scrapes recent posts from a LinkedIn company page via Apify. Returns an array of posts with text, reactions, and comments. Takes ~10-30s.",
      schema: apifyLinkedinCompanyPostsSchema,
      handler: async (params) =>
        handleApifyLinkedinCompanyPosts(params as { url: string; maxPosts?: number }),
      destructive: false,
    },
  },
  {
    actorId: APIFY_LINKEDIN_POST_ACTOR,
    tool: {
      name: "apify_linkedin_post",
      description:
        "Scrapes a single LinkedIn post via Apify. Returns post content, author, reactions, and comments. Takes ~10-30s.",
      schema: apifyLinkedinPostSchema,
      handler: async (params) => handleApifyLinkedinPost(params as { url: string }),
      destructive: false,
    },
  },
  {
    actorId: APIFY_LINKEDIN_COMPANY_INSIGHTS_ACTOR,
    tool: {
      name: "apify_linkedin_company_insights",
      description:
        "Scrapes extended insights from a LinkedIn company page via Apify (growth signals, headcount trends, etc.). Takes ~10-30s.",
      schema: apifyLinkedinCompanyInsightsSchema,
      handler: async (params) => handleApifyLinkedinCompanyInsights(params as { url: string }),
      destructive: false,
    },
  },
];

const ALWAYS_ON_TOOLS: ToolDefinition[] = [
  {
    name: "apify_search_actors",
    description:
      "Search for Apify actors by keyword. Returns your own actors and relevant public ones. Use this when no specific apify_* wrapper matches — then call apify_run_actor with the chosen ID.",
    schema: apifySearchActorsSchema,
    handler: async (params) => handleApifySearchActors(params as { query: string }),
    destructive: false,
  },
  {
    name: "apify_run_actor",
    description:
      "Run any Apify actor by ID. Use ONLY if no specific apify_linkedin_* wrapper matches your need. Prefer the specialized wrappers for better reliability and input validation.",
    schema: apifyRunActorSchema,
    handler: async (params) =>
      handleApifyRunActor(params as { actorId: string; input: Record<string, unknown> }),
    destructive: true,
  },
];

function parseAllowlist(env: NodeJS.ProcessEnv): Set<string> | null {
  const raw = env.APIFY_ACTORS;
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  return new Set(list);
}

function buildTools(): ToolDefinition[] {
  const allow = parseAllowlist(process.env);
  const wrappers = allow
    ? WRAPPERS.filter((w) => allow.has(w.actorId)).map((w) => w.tool)
    : WRAPPERS.map((w) => w.tool);
  return [...wrappers, ...ALWAYS_ON_TOOLS];
}

export const apifyConnector: ConnectorManifest = {
  id: "apify",
  label: "Apify",
  description:
    "Scrape LinkedIn profiles, companies, and posts via Apify actors — plus a search/escape hatch for any actor in the Apify store.",
  guide: `Run Apify actors (LinkedIn scrapers and anything else in the Apify store) using your personal API token.

### Prerequisites
An [Apify](https://apify.com) account with credits or a paid plan. The LinkedIn wrappers call rented actors that cost a few cents per run.

### How to get credentials
1. Sign in to the [Apify Console](https://console.apify.com)
2. Open **Settings → Integrations → API & Integrations**
3. Copy your **Personal API token** and set it as \`APIFY_TOKEN\`
4. Optional: set \`APIFY_ACTORS\` to a comma-separated allowlist of actor IDs if you want to restrict which wrappers are registered

### Troubleshooting
- _401 from Apify_: the token is wrong or was regenerated — grab a fresh one from Settings.
- _Actor run succeeds but dataset is empty_: LinkedIn actors occasionally get blocked; retry or switch to a different actor via \`apify_search_actors\`.
- _Out of credits_: top up your Apify account; each LinkedIn run consumes a small amount.`,
  requiredEnvVars: ["APIFY_TOKEN"],
  testConnection: async (credentials) => {
    const token = credentials.APIFY_TOKEN;
    if (!token) return { ok: false, message: "Missing Apify token" };
    const res = await fetch("https://api.apify.com/v2/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: { username?: string; email?: string } };
      const user = data?.data?.username || data?.data?.email || "Apify user";
      return { ok: true, message: `Connected as ${user}` };
    }
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      message: `Apify: ${res.status}`,
      detail: errText || `HTTP ${res.status}`,
    };
  },
  diagnose: async () => {
    try {
      const token = process.env.APIFY_TOKEN;
      if (!token) return { ok: false, message: "APIFY_TOKEN not set" };
      const res = await fetch("https://api.apify.com/v2/users/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: { username?: string } };
        return { ok: true, message: `Apify connected as ${data?.data?.username || "user"}` };
      }
      return { ok: false, message: `Apify API ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Cannot reach Apify" };
    }
  },
  get tools() {
    // Lazy getter so APIFY_ACTORS is read at resolve time, not module load.
    return buildTools();
  },
};
