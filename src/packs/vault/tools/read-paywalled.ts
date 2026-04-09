import { z } from "zod";

const MAX_ARTICLE_SIZE = 5 * 1024 * 1024;
const JINA_TIMEOUT = 20_000; // 20s — paywalled content can be slower

export const readPaywalledSchema = {
  url: z.string().url().describe("URL of the paywalled article (Medium, etc.)"),
};

export async function handleReadPaywalled(params: { url: string }) {
  const mediumSid = process.env.MEDIUM_SID?.trim();

  // Detect Medium URLs and require SID
  const isMedium =
    params.url.includes("medium.com") ||
    params.url.includes("towardsdatascience.com") ||
    params.url.includes("betterprogramming.pub") ||
    params.url.includes("levelup.gitconnected.com");

  if (isMedium && !mediumSid) {
    throw new Error(
      "MEDIUM_SID env var not configured. Add your Medium session cookie to Vercel env vars."
    );
  }

  // Fetch via Jina Reader with cookie forwarding
  const jinaUrl = `https://r.jina.ai/${params.url}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JINA_TIMEOUT);

  const jinaHeaders: Record<string, string> = {
    Accept: "text/markdown",
  };

  // Forward Medium cookie via Jina's x-set-cookie header
  if (isMedium && mediumSid) {
    jinaHeaders["x-set-cookie"] = `sid=${mediumSid}`;
  }

  let res: Response;
  try {
    res = await fetch(jinaUrl, {
      headers: jinaHeaders,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch article: ${res.status} ${res.statusText}`);
  }

  const markdown = await res.text();
  if (markdown.length > MAX_ARTICLE_SIZE) {
    throw new Error(`Article too large (${Math.round(markdown.length / 1024 / 1024)}MB). Max: 5MB`);
  }

  // Extract title from Jina metadata
  const titleMatch = markdown.match(/^Title:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : new URL(params.url).hostname;

  // Check if we actually got past the paywall
  const seemsPaywalled =
    markdown.includes("Member-only story") ||
    markdown.includes("Read the full story") ||
    markdown.length < 500;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            title,
            source: params.url,
            contentLength: markdown.length,
            paywallBypassed: !seemsPaywalled,
            warning: seemsPaywalled
              ? "Content may still be behind paywall. Check if MEDIUM_SID cookie is valid/fresh."
              : undefined,
          },
          null,
          2
        ) +
          "\n\n---\n\n" +
          markdown,
      },
    ],
  };
}
