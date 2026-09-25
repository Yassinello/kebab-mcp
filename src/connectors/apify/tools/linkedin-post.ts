import { z } from "zod";
import { runActor } from "../lib/client";
import { fetchWithTimeout } from "@/core/fetch-utils";

export const APIFY_LINKEDIN_POST_ACTOR = "supreme_coder/linkedin-post";

const SHORTLINK_HOSTS = new Set(["lnkd.in", "www.lnkd.in"]);
const RESOLVE_TIMEOUT_MS = 10_000;

export const apifyLinkedinPostSchema = {
  url: z
    .string()
    .url()
    .describe(
      "LinkedIn post URL (https://www.linkedin.com/posts/...). lnkd.in short links are resolved automatically."
    ),
};

function isShortlink(url: string): boolean {
  try {
    return SHORTLINK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Resolve an lnkd.in short link to its LinkedIn target. lnkd.in either
 * redirects (3xx) or serves an interstitial HTML page that embeds the
 * destination; handle both. Non-shortlinks are returned unchanged, and
 * any resolution failure falls back to the original URL.
 */
export async function resolveLinkedinShortlink(url: string): Promise<string> {
  if (!isShortlink(url)) return url;
  try {
    const res = await fetchWithTimeout(url, { redirect: "follow" }, RESOLVE_TIMEOUT_MS);
    if (res.url && !isShortlink(res.url)) return res.url;
    const html = await res.text();
    const match = html.match(/https?:\/\/(?:[a-z]+\.)?linkedin\.com\/[^"'<>\s]+/i);
    if (match) return match[0].replace(/&amp;/g, "&");
  } catch {
    // fall through — let the actor try the original URL
  }
  return url;
}

export async function handleApifyLinkedinPost(params: { url: string }) {
  const url = await resolveLinkedinShortlink(params.url);
  const items = await runActor(APIFY_LINKEDIN_POST_ACTOR, { urls: [url] });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }],
  };
}
