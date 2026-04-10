import { getGoogleAccessToken } from "./google-auth";

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

interface GoogleFetchOpts extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Fetch wrapper for Google APIs with:
 * - Auto Bearer token injection
 * - Retry with exponential backoff on 429 / 500 / 503
 * - Timeout (default 15s)
 * - Structured error messages
 */
export async function googleFetch(url: string, opts: GoogleFetchOpts = {}): Promise<Response> {
  const token = await getGoogleAccessToken();
  const timeoutMs = opts.timeoutMs || 15_000;

  const { timeoutMs: _, ...fetchOpts } = opts;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...fetchOpts,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...opts.headers,
        },
      });

      // Retry on rate limit or server errors
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = res.headers.get("Retry-After");
        const backoff = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }

      // Surface 4xx errors clearly (except 404 which callers may handle)
      if (res.status >= 400 && res.status !== 404) {
        const body = await res.text();
        let detail = body;
        try {
          const json = JSON.parse(body);
          detail = json.error?.message || json.error_description || body;
        } catch {
          /* not JSON */
        }
        throw new Error(`Google API ${res.status}: ${detail} (${opts.method || "GET"} ${url})`);
      }

      return res;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        if (attempt < MAX_RETRIES) {
          await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`Google API timeout after ${timeoutMs}ms: ${url}`, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new Error(`Google API: max retries exceeded for ${url}`);
}

/**
 * googleFetch + parse JSON response
 */
export async function googleFetchJSON<T = unknown>(
  url: string,
  opts: GoogleFetchOpts = {}
): Promise<T> {
  const res = await googleFetch(url, opts);
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
