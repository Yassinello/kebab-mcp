import {
  createBrowserSession,
  validatePublicUrl,
  validateContextName,
  sanitizeError,
} from "../lib/browserbase";
import { clampNavTimeout, scrollPage } from "../lib/page-helpers";

type WebBrowseParams = {
  url: string;
  scroll_count?: number | "auto" | undefined;
  nav_timeout_ms?: number | undefined;
  context_name?: string | undefined;
};

export async function handleWebBrowse(params: WebBrowseParams) {
  await validatePublicUrl(params.url);
  const contextName = validateContextName(params.context_name || "default");
  const stagehand = await createBrowserSession(contextName);

  try {
    const page = stagehand.context.pages()[0];
    if (!page) throw new Error("Stagehand returned no page (unexpected state)");

    await page.goto(params.url, {
      waitUntil: "domcontentloaded",
      timeoutMs: clampNavTimeout(params.nav_timeout_ms),
    });

    await scrollPage(page, params.scroll_count);

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
