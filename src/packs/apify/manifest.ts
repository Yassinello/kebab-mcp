import type { PackManifest, ToolDefinition } from "@/core/types";
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
  },
  {
    name: "apify_run_actor",
    description:
      "Run any Apify actor by ID. Use ONLY if no specific apify_linkedin_* wrapper matches your need. Prefer the specialized wrappers for better reliability and input validation.",
    schema: apifyRunActorSchema,
    handler: async (params) =>
      handleApifyRunActor(params as { actorId: string; input: Record<string, unknown> }),
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

export const apifyPack: PackManifest = {
  id: "apify",
  label: "Apify",
  description:
    "Scrape LinkedIn profiles, companies, and posts via Apify actors — plus a search/escape hatch for any actor in the Apify store.",
  requiredEnvVars: ["APIFY_TOKEN"],
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
