import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { findSourceForUrl } from "../lib/source-lookup";
import { extractArticle, PaywallExtractError } from "../lib/extract";
import { SOURCES } from "../sources";
import {
  createBrowserSession,
  validatePublicUrl,
  sanitizeError,
} from "@/connectors/browser/lib/browserbase";
import { getConfig } from "@/core/config-facade";

export const readPaywalledHardSchema = {
  url: z.string().url().describe("URL of the paywalled article (Medium, Substack)"),
};

/**
 * Tier 2 registers only when Browserbase credentials exist — we reuse the
 * Browser pack's env-var contract directly so behavior stays consistent.
 */
export function isBrowserPackConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.BROWSERBASE_API_KEY && env.BROWSERBASE_PROJECT_ID && env.OPENROUTER_API_KEY);
}

function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function okResult(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export async function handleReadPaywalledHard(params: { url: string }): Promise<ToolResult> {
  const { url } = params;

  validatePublicUrl(url);

  const source = findSourceForUrl(url);
  if (!source) {
    const supported = SOURCES.map((s) => s.displayName).join(", ");
    return errorResult(`No paywall source registered for this domain. Supported: ${supported}.`);
  }

  const cookieValue = getConfig(source.cookieEnvVar)?.trim();
  if (!cookieValue) {
    return errorResult(
      `Cookie not configured for ${source.displayName}. Add ${source.cookieEnvVar} in /config → Packs → Paywall.`
    );
  }

  const parsed = new URL(url);
  const stagehand = await createBrowserSession("default");
  try {
    // Inject the session cookie for the article's host so the browser loads
    // the full paid content.
    await stagehand.context.addCookies([
      {
        name: source.cookieName,
        value: cookieValue,
        domain: `.${parsed.hostname.replace(/^www\./, "")}`,
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      },
    ]);

    const page = stagehand.context.pages()[0];
    await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 30_000 });

    // Give SPAs a moment to hydrate the article body.
    await new Promise((r) => setTimeout(r, 1500));

    // Stagehand's Page wraps Playwright and doesn't expose `content()`
    // directly on its type, so read the serialized DOM via evaluate.
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const finalUrl = page.url();

    try {
      const article = extractArticle(html, finalUrl);
      return okResult({
        title: article.title,
        author: article.author,
        date: article.date,
        markdown: article.markdown,
        url: finalUrl,
        source: source.id,
        wordCount: article.wordCount,
        tier: "hard",
      });
    } catch (err) {
      if (err instanceof PaywallExtractError) {
        return errorResult(
          `Browser rendered the page but could not find an article. Cookie may be expired — re-extract and update ${source.cookieEnvVar} in /config.`
        );
      }
      throw err;
    }
  } catch (err) {
    return errorResult(`read_paywalled_hard failed: ${sanitizeError(err)}`);
  } finally {
    await stagehand.close();
  }
}
