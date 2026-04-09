import { z } from "zod";
import {
  createBrowserSession,
  validatePublicUrl,
  validateContextName,
  sanitizeError,
} from "../lib/browserbase";

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

export async function handleWebExtract(params: {
  url: string;
  instruction: string;
  scroll_count?: number;
  context_name?: string;
}) {
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
      content: [{ type: "text" as const, text: `Error extracting from ${params.url}: ${sanitizeError(err)}` }],
      isError: true,
    };
  } finally {
    await stagehand.close();
  }
}
