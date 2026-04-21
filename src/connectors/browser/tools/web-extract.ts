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

export const webExtractSchema = {
  url: z.string().describe("URL to extract data from"),
  instruction: z
    .string()
    .describe(
      "What to extract, in natural language. Example: 'Extract all feed posts with author, content, likes count, and date'"
    ),
  scroll_count: z
    .number()
    .optional()
    .describe("Scroll before extracting to load more content (default: 0)"),
  context_name: z
    .string()
    .optional()
    .describe("Browser context for session persistence (default: 'default')"),
};

type WebExtractParams = {
  url: string;
  instruction: string;
  scroll_count?: number;
  context_name?: string;
};

/**
 * V2-compat path (default). Frozen for safe rollback.
 */
export async function handleWebExtractV2(params: WebExtractParams) {
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

    const result = await stagehand.extract(params.instruction);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err: unknown) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error extracting from ${params.url}: ${sanitizeError(err)}`,
        },
      ],
      isError: true,
    };
  } finally {
    await stagehand.close();
  }
}

/**
 * V3 path — delegates to V2 today. TODO: switch to page.extract() (v3
 * idiomatic) when the project needs those semantics.
 */
export async function handleWebExtractV3(params: WebExtractParams) {
  return handleWebExtractV2(params);
}

export async function handleWebExtract(params: WebExtractParams) {
  const version = getBrowserConnectorVersion();
  return version === "v3" ? handleWebExtractV3(params) : handleWebExtractV2(params);
}
