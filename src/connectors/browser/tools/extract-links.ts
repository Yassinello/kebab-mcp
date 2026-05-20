import {
  createBrowserSession,
  validatePublicUrl,
  validateContextName,
  sanitizeError,
} from "../lib/browserbase";
import { clampNavTimeout, scrollPage } from "../lib/page-helpers";

type ExtractLinksParams = {
  url: string;
  selector?: string | undefined;
  href_pattern?: string | undefined;
  scroll_count?: number | "auto" | undefined;
  nav_timeout_ms?: number | undefined;
  limit?: number | undefined;
  context_name?: string | undefined;
};

type RawLink = { href: string; text: string; title: string | undefined };

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

const DEFAULT_LIMIT = 100;
const HARD_LIMIT = 500;
// CSS selectors and href regexes are user-controlled. Cap their length
// to neutralize a class of self-DoS vectors (deeply nested `:has()`
// selectors, catastrophic backtracking regexes — review findings #3/#4,
// 2026-05-01). 200 chars is comfortably above any realistic legitimate
// pattern.
const PATTERN_MAX_LEN = 200;

/**
 * Pull anchors directly from the DOM via `page.evaluate`. No LLM
 * round-trip — meaning:
 *
 * - Hrefs are the actual `el.href` attribute, not LLM-generated. Solves
 *   the Vinted hallucination class of bugs (2026-04-30) where the
 *   extractor invents short numeric IDs for items.
 * - Sub-second on listing pages once content is loaded.
 * - Doesn't dedupe across pages — caller's job.
 *
 * Caller can scope with a CSS selector and/or post-filter by href
 * substring or regex (slash-delimited, e.g. `/items/[a-z0-9-]+/i`).
 */
export async function handleExtractLinks(params: ExtractLinksParams): Promise<ToolResult> {
  await validatePublicUrl(params.url);
  const contextName = validateContextName(params.context_name || "default");
  const limit = Math.min(HARD_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));
  if (params.selector && params.selector.length > PATTERN_MAX_LEN) {
    return errorResult(`selector too long (max ${PATTERN_MAX_LEN} chars)`);
  }
  if (params.href_pattern && params.href_pattern.length > PATTERN_MAX_LEN) {
    return errorResult(`href_pattern too long (max ${PATTERN_MAX_LEN} chars)`);
  }
  const matcher = compileHrefMatcher(params.href_pattern);
  if (matcher.kind === "error") return errorResult(matcher.message);

  const stagehand = await createBrowserSession(contextName);

  try {
    const page = stagehand.context.pages()[0];
    if (!page) throw new Error("Stagehand returned no page (unexpected state)");

    await page.goto(params.url, {
      waitUntil: "domcontentloaded",
      timeoutMs: clampNavTimeout(params.nav_timeout_ms),
    });

    await scrollPage(page, params.scroll_count);

    // Selector is forwarded as an argument, never interpolated into the
    // page-side function source. Stagehand's `evaluate` stringifies the
    // function and ships it to the page via CDP — same isolation as
    // Playwright's $$eval.
    const selector = params.selector || "a[href]";
    const links = await page.evaluate<RawLink[], string>((sel) => {
      const out: RawLink[] = [];
      const els = document.querySelectorAll(sel);
      for (const el of Array.from(els)) {
        if (!(el instanceof HTMLAnchorElement)) continue;
        // Skip non-http(s) anchors (javascript:, mailto:, tel:, data:).
        // The caller will hit `validatePublicUrl` on these later anyway,
        // so returning them just adds noise + a confusing rejection
        // downstream (review finding #10, 2026-05-01).
        if (!/^https?:/i.test(el.href)) continue;
        out.push({
          href: el.href,
          text: (el.textContent || "").trim().slice(0, 200),
          title: el.title || undefined,
        });
      }
      return out;
    }, selector);

    if (!Array.isArray(links)) {
      // Defensive: page.evaluate is typed as `R` but if Stagehand falls
      // back to a string serialization on non-JSON output, iterating it
      // would silently yield chars and we'd report `total_matched: 0`
      // while the page actually has links — a misleading lie (review
      // finding #2).
      return errorResult("page.evaluate did not return an array — page may have failed to load");
    }

    const filtered: RawLink[] = [];
    const seen = new Set<string>();
    for (const link of links) {
      if (!link.href || seen.has(link.href)) continue;
      if (matcher.kind === "fn" && !matcher.fn(link.href)) continue;
      seen.add(link.href);
      filtered.push(link);
      if (filtered.length >= limit) break;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              url: page.url(),
              total_matched: filtered.length,
              limited: filtered.length === limit && links.length > limit,
              links: filtered,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: unknown) {
    return errorResult(`Error extracting links from ${params.url}: ${sanitizeError(err)}`);
  } finally {
    await stagehand.close();
  }
}

type Matcher =
  | { kind: "noop" }
  | { kind: "fn"; fn: (href: string) => boolean }
  | { kind: "error"; message: string };

function compileHrefMatcher(pattern: string | undefined): Matcher {
  if (!pattern) return { kind: "noop" };
  // Slash-delimited regex, optionally with flags: /foo/i
  const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      const re = new RegExp(regexMatch[1] ?? "", regexMatch[2] ?? "");
      return { kind: "fn", fn: (href) => re.test(href) };
    } catch (err) {
      return { kind: "error", message: `Invalid regex: ${(err as Error).message}` };
    }
  }
  return { kind: "fn", fn: (href) => href.includes(pattern) };
}

function errorResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}
