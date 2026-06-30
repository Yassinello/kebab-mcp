import { getGoogleAccessToken, type GoogleAuthContext } from "./google-auth";
import { McpToolError, ErrorCode } from "@/core/errors";
import { GoogleAuthError, GoogleRateLimitError } from "@/core/connector-errors";

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

interface GoogleFetchOpts extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Node fetch() (undici) reuses TCP connections via its internal connection
 * pool. No manual keep-alive or agent configuration is needed.
 *
 * Fetch wrapper for Google APIs with:
 * - Auto Bearer token injection
 * - Retry with exponential backoff on 429 / 500 / 503
 * - Timeout (default 15s)
 * - Structured error messages
 */
export async function googleFetch(
  ctx: GoogleAuthContext,
  url: string,
  opts: GoogleFetchOpts = {}
): Promise<Response> {
  const token = await getGoogleAccessToken(ctx);
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

      if (res.status === 429) {
        throw new GoogleRateLimitError(`Google API rate limited: ${url}`);
      }

      // Surface 4xx errors clearly (except 404 which callers may handle)
      if (res.status === 401 || res.status === 403) {
        const body = await res.text();
        let detail = body;
        try {
          const json = JSON.parse(body);
          detail = json.error?.message || json.error_description || body;
        } catch {
          /* not JSON */
        }
        throw new GoogleAuthError(`Google API ${res.status}: ${detail}`);
      }

      if (res.status >= 400 && res.status !== 404) {
        const body = await res.text();
        let detail = body;
        try {
          const json = JSON.parse(body);
          detail = json.error?.message || json.error_description || body;
        } catch {
          /* not JSON */
        }
        throw new McpToolError({
          code: ErrorCode.EXTERNAL_API_ERROR,
          toolName: "google",
          message: `Google API ${res.status}: ${detail} (${opts.method || "GET"} ${url})`,
          userMessage: `Google API error (${res.status}): ${detail}`,
          retryable: res.status >= 500,
        });
      }

      return res;
    } catch (err: unknown) {
      if (err instanceof McpToolError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        if (attempt < MAX_RETRIES) {
          await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        throw new McpToolError({
          code: ErrorCode.TIMEOUT,
          toolName: "google",
          message: `Google API timeout after ${timeoutMs}ms: ${url}`,
          userMessage: "Google API request timed out. Please try again.",
          retryable: true,
          cause: err,
        });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new McpToolError({
    code: ErrorCode.EXTERNAL_API_ERROR,
    toolName: "google",
    message: `Google API: max retries exceeded for ${url}`,
    userMessage: "Google API is unavailable after multiple retries. Please try again later.",
    retryable: true,
  });
}

/**
 * googleFetch + parse JSON response
 */
export async function googleFetchJSON<T = unknown>(
  ctx: GoogleAuthContext,
  url: string,
  opts: GoogleFetchOpts = {}
): Promise<T> {
  const res = await googleFetch(ctx, url, opts);
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
