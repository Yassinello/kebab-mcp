// Phase 44 SCM-01: V2/V3 dispatch gated on KEBAB_BROWSER_CONNECTOR_V2.
// See .planning/phases/44-supply-chain/MIGRATION-NOTES.md.

import { z } from "zod";
import {
  createBrowserSession,
  validatePublicUrl,
  validateContextName,
  sanitizeError,
} from "../lib/browserbase";
import { getBrowserConnectorVersion } from "../flag";

export const webBrowseSchema = {
  url: z.string().describe("URL to navigate to"),
  scroll_count: z
    .number()
    .optional()
    .describe("Times to scroll down to load more content (default: 0)"),
  context_name: z
    .string()
    .optional()
    .describe(
      "Browser context for session persistence. Use 'linkedin' for LinkedIn, 'default' for anonymous."
    ),
};

type WebBrowseParams = {
  url: string;
  scroll_count?: number;
  context_name?: string;
};

/**
 * V2-compat path (default). Preserves the exact current handler behavior
 * — frozen for safe rollback. Do not modify without a rollback plan.
 */
export async function handleWebBrowseV2(params: WebBrowseParams) {
  validatePublicUrl(params.url);
  const contextName = validateContextName(params.context_name || "default");
  const stagehand = await createBrowserSession(contextName);

  try {
    const page = stagehand.context.pages()[0];

    await page.goto(params.url, {
      waitUntil: "domcontentloaded",
      timeoutMs: 30000,
    });

    // Scroll to load dynamic content
    const scrolls = params.scroll_count || 0;
    for (let i = 0; i < scrolls; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      const delay = 1500 + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }

    // Extract visible text content
    const content = await page.evaluate(() => {
      const remove = document.querySelectorAll(
        "script, style, nav, footer, header, [role='banner']"
      );
      remove.forEach((el) => el.remove());
      const text = document.body?.innerText || "";
      return text.slice(0, 5000);
    });

    const title = await page.title();
    const finalUrl = page.url();

    return {
      content: [
        {
          type: "text" as const,
          text: `**${title}**\n${finalUrl}\n\n${content}`,
        },
      ],
    };
  } catch (err: unknown) {
    return {
      content: [
        { type: "text" as const, text: `Error browsing ${params.url}: ${sanitizeError(err)}` },
      ],
      isError: true,
    };
  } finally {
    await stagehand.close();
  }
}

/**
 * V3 path — reserved for future divergence once the project needs Stagehand
 * v3 idiomatic calls (page.act / page.extract / page.observe). Today it
 * delegates to V2 because the installed Stagehand 3.2.1 is back-compat with
 * v2 call patterns. TODO: exercise page.goto's v3-native options when that
 * becomes the idiom the project wants.
 */
export async function handleWebBrowseV3(params: WebBrowseParams) {
  return handleWebBrowseV2(params);
}

/**
 * Public dispatcher — used by the manifest. Reads the flag per-call so env
 * flips at runtime are honored.
 */
export async function handleWebBrowse(params: WebBrowseParams) {
  const version = getBrowserConnectorVersion();
  return version === "v3" ? handleWebBrowseV3(params) : handleWebBrowseV2(params);
}
