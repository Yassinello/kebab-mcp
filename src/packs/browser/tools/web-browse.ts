import { z } from "zod";
import {
  createBrowserSession,
  validatePublicUrl,
  validateContextName,
  sanitizeError,
} from "../lib/browserbase";

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

export async function handleWebBrowse(params: {
  url: string;
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
