/**
 * safeFetch — outbound fetch for URLs influenced by LLM tool arguments or
 * operator-defined connections (SEC-08, 2026-11 audit).
 *
 * Guarantees, on top of `fetchWithTimeout`:
 *  - redirects are followed MANUALLY and every hop is re-validated with the
 *    SSRF guard (`isPublicUrl` with DNS resolution) — the platform's
 *    automatic redirect following would happily land on 169.254.169.254
 *    or an RFC1918 address after a 302 from a public host;
 *  - on any change of origin, credential-bearing headers (Authorization,
 *    Cookie, Proxy-Authorization, plus caller-declared ones such as a
 *    custom API-key header) are dropped before the next hop;
 *  - 303 (and 301/302 on non-GET/HEAD) downgrade to GET without a body,
 *    matching browser semantics;
 *  - a bounded number of hops.
 *
 * Not covered (accepted risk, see docs/audits/2026-11-cdc-remediation.md):
 * DNS pinning between the guard's lookup and the socket connect.
 */
import { fetchWithTimeout } from "./fetch-utils";
import { isPublicUrl, type IsPublicUrlOptions } from "./url-safety";

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  /** Options forwarded to the SSRF guard. `resolveDns` defaults to true. */
  urlSafety?: IsPublicUrlOptions;
  /** Extra header names (case-insensitive) to drop when the origin changes. */
  sensitiveHeaders?: string[];
}

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

const ALWAYS_SENSITIVE = ["authorization", "cookie", "proxy-authorization"];

export interface SafeFetchResult {
  response: Response;
  /** URL of the final hop (after redirects). */
  finalUrl: string;
  /** Number of redirects followed. */
  redirects: number;
}

function toHeaderRecord(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  // Plain objects keep their original casing (callers and tests rely on it).
  if (!(h instanceof Headers) && !Array.isArray(h)) return { ...(h as Record<string, string>) };
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export async function safeFetch(
  url: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const safety: IsPublicUrlOptions = { resolveDns: true, ...(opts.urlSafety ?? {}) };
  const sensitive = new Set([
    ...ALWAYS_SENSITIVE,
    ...(opts.sensitiveHeaders ?? []).map((h) => h.toLowerCase()),
  ]);

  let currentUrl = url;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  let headers = toHeaderRecord(init.headers);
  const originalOrigin = new URL(url).origin;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await isPublicUrl(currentUrl, safety);
    if (!check.ok) {
      throw new SafeFetchError(
        hop === 0
          ? `URL rejected: ${check.error.message}`
          : `Redirect target rejected: ${check.error.message}`
      );
    }

    const hopInit: RequestInit = { ...init, method, headers, redirect: "manual" };
    if (body === undefined || body === null) delete hopInit.body;
    else hopInit.body = body;
    const response = await fetchWithTimeout(currentUrl, hopInit, opts.timeoutMs);

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get("location");
    if (!isRedirect || !location) {
      return { response, finalUrl: currentUrl, redirects: hop };
    }
    // Drain the redirect body so the connection can be reused.
    await response.body?.cancel().catch(() => undefined);

    if (hop === maxRedirects) {
      throw new SafeFetchError(`Too many redirects (max ${maxRedirects})`);
    }

    const next = new URL(location, currentUrl);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new SafeFetchError(`Redirect to unsupported scheme ${next.protocol}`);
    }
    if (next.origin !== originalOrigin) {
      headers = Object.fromEntries(
        Object.entries(headers).filter(([k]) => !sensitive.has(k.toLowerCase()))
      );
    }
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        method !== "GET" &&
        method !== "HEAD")
    ) {
      method = "GET";
      body = undefined;
      headers = Object.fromEntries(
        Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-type")
      );
    }
    currentUrl = next.toString();
  }
  // Unreachable: the loop either returns or throws.
  throw new SafeFetchError("redirect loop");
}
