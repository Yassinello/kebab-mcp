import { z } from "zod";
import { handleWebExtract } from "./web-extract";
import { checkAndIncrementDailyLimit } from "../lib/browserbase";

const LINKEDIN_DAILY_LIMIT = 3;

export const linkedinFeedSchema = {
  max_posts: z
    .number()
    .optional()
    .describe("Max posts to return (default: 20, max: 30)"),
};

export async function handleLinkedinFeed(params: { max_posts?: number }) {
  const { allowed, count } = await checkAndIncrementDailyLimit(
    LINKEDIN_DAILY_LIMIT
  );

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

  return handleWebExtract({
    url: "https://www.linkedin.com/feed/",
    instruction: `Extract all visible LinkedIn feed posts. For each post return:
- author: full name of the person who posted
- content: text content of the post (first 500 characters max)
- likes: approximate number of likes/reactions (number)
- comments: approximate number of comments (number)
- date: relative date as shown on LinkedIn (e.g. "2h", "3d", "1w")
Return as a JSON array of objects. Max ${maxPosts} posts.`,
    scroll_count: 3,
    context_name: "linkedin",
  });
}
