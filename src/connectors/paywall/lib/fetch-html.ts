import { fetchWithByteCap } from "@/core/fetch-utils";
import { isPublicUrl } from "@/core/url-safety";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Phase 44 SCM-05b: 10s explicit timeout preserved. The inline AbortController
// is retained here because fetchWithByteCap is a specialized streaming variant
// that owns its own body reader — layering fetchWithTimeout on top would
// double-wrap the signal for no benefit. This is the ONE site where an
// inline AbortController+setTimeout pattern is preserved; it is not a
// fetchWithTimeout-equivalent because the timeout needs to cover the full
// streaming read window, not just the fetch() promise resolution.
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5MB safety cap
const MAX_REDIRECTS = 5;

/**
 * MEDIUM SSRF fix: this request carries the user's authenticated `Cookie`
 * header, so a redirect to an attacker-controlled or internal host would
 * leak that cookie / reach internal services. We previously used
 * `redirect: "follow"` with no URL validation. Now we:
 *   1. validate the initial URL with DNS resolution (fail-closed), and
 *   2. follow redirects MANUALLY, re-validating each Location hop before
 *      re-issuing the fetch (with the cookie) — so a 30x bounce to
 *      169.254.169.254 / 10.x / loopback is refused.
 */
async function assertPublicUrl(url: string): Promise<void> {
  const safety = await isPublicUrl(url, { resolveDns: true });
  if (!safety.ok) {
    throw new Error(`URL rejected (SSRF guard): ${safety.error.message}`);
  }
}

export async function fetchHtmlWithCookie(
  url: string,
  cookieHeader: string
): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(currentUrl);

      const result = await fetchWithByteCap(
        currentUrl,
        {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
            Cookie: cookieHeader,
          },
        },
        MAX_HTML_BYTES
      );

      // Manual redirect handling: re-validate the next hop before following.
      if (result.status >= 300 && result.status < 400) {
        if (!result.location) {
          throw new Error(`Upstream returned ${result.status} with no Location header`);
        }
        // Resolve relative redirects against the current URL.
        currentUrl = new URL(result.location, currentUrl).toString();
        continue;
      }

      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Upstream returned ${result.status}`);
      }
      if (result.truncated) {
        throw new Error(
          `Response body too large (exceeded ${Math.round(MAX_HTML_BYTES / 1024 / 1024)}MB cap)`
        );
      }
      return { html: result.text, finalUrl: result.finalUrl };
    }
    throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
