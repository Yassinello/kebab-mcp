/**
 * Minimal Apify REST client — direct fetch, no SDK.
 * All calls authenticate via `?token=...` query param (sync endpoint) or
 * `Authorization: Bearer ${token}` header (read endpoints).
 */

import { fetchWithTimeout } from "@/core/fetch-utils";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";

const APIFY_BASE = "https://api.apify.com/v2";
const RUN_SYNC_TIMEOUT_SECONDS = 55;
// Phase 44 SCM-05b: 60s explicit timeout preserved from prior local helper.
const APIFY_FETCH_TIMEOUT_MS = 60_000;

function getToken(): string {
  const t = getConfig("APIFY_TOKEN");
  if (!t) throw new Error("APIFY_TOKEN is not set");
  return t;
}

/** Strip the token from any string (URLs, error bodies) before returning it. */
function sanitize(text: string): string {
  const token = getConfig("APIFY_TOKEN");
  if (!token) return text;
  return text.split(token).join("<redacted>");
}

/**
 * Run an Apify actor synchronously and return its dataset items.
 * Uses the `run-sync-get-dataset-items` endpoint with a 55s server-side timeout.
 *
 * @param actorId e.g. "harvestapi/linkedin-profile-scraper"
 * @param input actor input object (passed as JSON body)
 */
export async function runActor(
  actorId: string,
  input: Record<string, unknown>
): Promise<unknown[]> {
  const token = getToken();
  // Apify accepts either `owner/name` or `owner~name` in the path; `~` is safer.
  const path = actorId.includes("/") ? actorId.replace("/", "~") : actorId;
  const url = `${APIFY_BASE}/acts/${encodeURIComponent(path)}/run-sync-get-dataset-items?timeout=${RUN_SYNC_TIMEOUT_SECONDS}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(input),
      },
      APIFY_FETCH_TIMEOUT_MS
    );
  } catch (err) {
    const msg = toMsg(err);
    throw new Error(sanitize(`Apify fetch failed: ${msg}`), { cause: err });
  }

  if (res.status === 408 || res.status === 504) {
    throw new Error(
      `Actor '${actorId}' did not complete within ${RUN_SYNC_TIMEOUT_SECONDS}s. Try a smaller input or check Apify console for run status.`
    );
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(
      sanitize(`Apify actor '${actorId}' failed (${res.status}): ${bodyText || res.statusText}`)
    );
  }

  const data = await res.json().catch(() => null);
  if (!Array.isArray(data)) {
    // Some actors may return a single object; normalize to array.
    return data == null ? [] : [data];
  }
  return data as unknown[];
}

/** GET helper that uses Bearer auth — for read endpoints like /acts and /store. */
export async function apifyGet<T = unknown>(pathAndQuery: string): Promise<T> {
  const token = getToken();
  const url = `${APIFY_BASE}${pathAndQuery}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      APIFY_FETCH_TIMEOUT_MS
    );
  } catch (err) {
    const msg = toMsg(err);
    throw new Error(sanitize(`Apify fetch failed: ${msg}`), { cause: err });
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(sanitize(`Apify GET ${pathAndQuery} failed (${res.status}): ${bodyText}`));
  }
  return (await res.json()) as T;
}

export { sanitize as sanitizeApifyError };
