import {
  createBrowserSession,
  validatePublicUrl,
  validateContextName,
  sanitizeError,
} from "../lib/browserbase";
import { clampNavTimeout, scrollPage } from "../lib/page-helpers";

type WebObserveParams = {
  url: string;
  instruction: string;
  scroll_count?: number | "auto" | undefined;
  nav_timeout_ms?: number | undefined;
  context_name?: string | undefined;
};

/**
 * Stagehand `observe` — surface candidate actions matching an instruction
 * (e.g. "all clickable product cards"). Returns CSS selectors + textual
 * descriptions. Useful when:
 *
 * - `web_extract` is too slow/expensive (no LLM extraction round)
 * - the caller wants to discover selectors before calling `web_act`
 * - extracting raw `href`s is the goal but selectors aren't known up front
 */
export async function handleWebObserve(params: WebObserveParams) {
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

    const candidates = await stagehand.observe(params.instruction);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              count: candidates.length,
              candidates: candidates.map((c) => ({
                selector: c.selector,
                description: c.description,
                method: c.method,
                arguments: c.arguments,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: unknown) {
    return {
      content: [
        { type: "text" as const, text: `Error observing ${params.url}: ${sanitizeError(err)}` },
      ],
      isError: true,
    };
  } finally {
    await stagehand.close();
  }
}
