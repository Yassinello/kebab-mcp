// Phase 44 SCM-01: V2/V3 dispatch gated on KEBAB_BROWSER_CONNECTOR_V2.
// See .planning/phases/44-supply-chain/MIGRATION-NOTES.md.

import { z } from "zod";
import { handleWebExtractV2, handleWebExtractV3 } from "./web-extract";
import { checkAndIncrementDailyLimit } from "../lib/browserbase";
import { getBrowserConnectorVersion } from "../flag";

const LINKEDIN_DAILY_LIMIT = 3;

export const linkedinFeedSchema = {
  max_posts: z.number().optional().describe("Max posts to return (default: 20, max: 30)"),
};

type LinkedinFeedParams = { max_posts?: number };

function extractArgsForFeed(max: number) {
  return {
    url: "https://www.linkedin.com/feed/",
    instruction: `Extract all visible LinkedIn feed posts. For each post return:
- author: full name of the person who posted
- content: text content of the post (first 500 characters max)
- likes: approximate number of likes/reactions (number)
- comments: approximate number of comments (number)
- date: relative date as shown on LinkedIn (e.g. "2h", "3d", "1w")
Return as a JSON array of objects. Max ${max} posts.`,
    scroll_count: 3,
    context_name: "linkedin",
  };
}

/**
 * V2-compat path (default). Uses handleWebExtractV2 directly so the
 * linkedin_feed dispatch is locked to the V2 extractor regardless of flag.
 */
export async function handleLinkedinFeedV2(params: LinkedinFeedParams) {
  const { allowed, count } = await checkAndIncrementDailyLimit(LINKEDIN_DAILY_LIMIT);

  if (!allowed) {
    return {
      content: [
        {
          type: "text" as const,
          text: `LinkedIn feed rate limited: ${count}/${LINKEDIN_DAILY_LIMIT} calls used today. Resets at midnight (Europe/Paris). Try again tomorrow to avoid LinkedIn detection.`,
        },
      ],
      isError: true,
    };
  }

  const maxPosts = Math.min(params.max_posts || 20, 30);
  return handleWebExtractV2(extractArgsForFeed(maxPosts));
}

/**
 * V3 path — delegates to V2 via the V3 extractor (which itself delegates to V2
 * today). Keeps the V3 branch wired so future divergence of handleWebExtractV3
 * automatically flows through linkedin_feed when the flag flips.
 */
export async function handleLinkedinFeedV3(params: LinkedinFeedParams) {
  const { allowed, count } = await checkAndIncrementDailyLimit(LINKEDIN_DAILY_LIMIT);

  if (!allowed) {
    return {
      content: [
        {
          type: "text" as const,
          text: `LinkedIn feed rate limited: ${count}/${LINKEDIN_DAILY_LIMIT} calls used today. Resets at midnight (Europe/Paris). Try again tomorrow to avoid LinkedIn detection.`,
        },
      ],
      isError: true,
    };
  }

  const maxPosts = Math.min(params.max_posts || 20, 30);
  return handleWebExtractV3(extractArgsForFeed(maxPosts));
}

export async function handleLinkedinFeed(params: LinkedinFeedParams) {
  const version = getBrowserConnectorVersion();
  return version === "v3" ? handleLinkedinFeedV3(params) : handleLinkedinFeedV2(params);
}
