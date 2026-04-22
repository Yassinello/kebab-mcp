import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { findSourceForUrl } from "../lib/source-lookup";
import { fetchHtmlWithCookie } from "../lib/fetch-html";
import { extractArticle, PaywallExtractError } from "../lib/extract";
import { SOURCES } from "../sources";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";

export const readPaywalledSchema = {
  url: z.string().url().describe("URL of the paywalled article (Medium, Substack)"),
};

function errorResult(message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function okResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export async function handleReadPaywalled(params: { url: string }): Promise<ToolResult> {
  const { url } = params;

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

  const cookieHeader = `${source.cookieName}=${cookieValue}`;

  let html: string;
  let finalUrl: string;
  try {
    const res = await fetchHtmlWithCookie(url, cookieHeader);
    html = res.html;
    finalUrl = res.finalUrl;
  } catch (err) {
    const msg = toMsg(err);
    return errorResult(`Failed to fetch ${source.displayName} article: ${msg}`);
  }

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
    });
  } catch (err) {
    if (err instanceof PaywallExtractError) {
      return errorResult(
        `Cookie appears expired or article unreadable. Re-extract it from your browser and update ${source.cookieEnvVar} in /config → Packs → Paywall. (If the article loads fine in your browser, try \`read_paywalled_hard\`.)`
      );
    }
    const msg = toMsg(err);
    return errorResult(`Extraction failed: ${msg}`);
  }
}
