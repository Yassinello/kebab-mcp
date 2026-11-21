/**
 * Upstream release check without a GitHub token (UPD-10..13, docs/specs/cdc-instances-testeurs.md).
 *
 * Why: one-click updates need a GitHub token on the user's repo. Most
 * people never create one, so their dashboard said nothing at all about
 * new versions and they stayed on the release of their install day.
 * Upstream (`Yassinello/kebab-mcp`) is public: its latest release can be
 * read anonymously, and the build knows its own version. Comparing the two
 * is enough to say "vX.Y.Z is available"; installing it still needs the
 * token (or GitHub's UI).
 *
 * Two sources, in order:
 *   1. `GET api.github.com/repos/<upstream>/releases/latest`, anonymous.
 *      Limited to 60 requests/hour per IP, and Vercel functions share
 *      egress IPs, so a 403/429 here is expected now and then.
 *   2. `github.com/<upstream>/releases/latest`, which answers with a 302 to
 *      `/releases/tag/vX.Y.Z`. Not counted against the REST API limit.
 *
 * Pure: no KV, no auth, no credentials. The caller caches the result
 * (UPSTREAM_RELEASE_KV_KEY) — the dashboard route and the daily cron.
 * Never throws: any failure gives `null`, and the caller shows nothing.
 */

// `@/*` maps to `./src/*` only — `app/landing/deploy-url` lives outside
// the alias and must be imported relatively from src/core.
import { UPSTREAM_OWNER, UPSTREAM_REPO_SLUG } from "../../app/landing/deploy-url";
import { compareVersions } from "./release-sync";

const UPSTREAM_FULL = `${UPSTREAM_OWNER}/${UPSTREAM_REPO_SLUG}`;

/** KV key of the cached latest upstream release (global, not tenant data). */
export const UPSTREAM_RELEASE_KV_KEY = "global:upstream-release";
/** Cache lifetime: a release a few hours late is fine; the cron refreshes daily. */
export const UPSTREAM_RELEASE_TTL_SECONDS = 6 * 60 * 60;
const FETCH_TIMEOUT_MS = 5_000;

export interface UpstreamRelease {
  /** `0.1.19` (no leading v). */
  version: string;
  /** `v0.1.19`. */
  tag: string;
  /** Release page on GitHub. */
  url: string;
  /** Which source answered. */
  source: "api" | "redirect";
  checkedAt: string;
}

const TAG_RE = /^v?(\d+\.\d+\.\d+)$/;

/** `v0.1.19` → `0.1.19`; anything that is not a plain x.y.z tag → null. */
export function versionFromTag(tag: string): string | null {
  const m = tag.trim().match(TAG_RE);
  return m ? m[1]! : null;
}

function release(tag: string, source: UpstreamRelease["source"]): UpstreamRelease | null {
  const version = versionFromTag(tag);
  if (!version) return null;
  return {
    version,
    tag: `v${version}`,
    url: `https://github.com/${UPSTREAM_FULL}/releases/tag/v${version}`,
    source,
    checkedAt: new Date().toISOString(),
  };
}

async function fromApi(): Promise<UpstreamRelease | null> {
  const res = await fetch(`https://api.github.com/repos/${UPSTREAM_FULL}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (typeof data.tag_name !== "string" || data.draft === true || data.prerelease === true) {
    return null;
  }
  return release(data.tag_name, "api");
}

async function fromRedirect(): Promise<UpstreamRelease | null> {
  const res = await fetch(`https://github.com/${UPSTREAM_FULL}/releases/latest`, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status < 300 || res.status >= 400) return null;
  const location = res.headers.get("location") ?? "";
  const m = location.match(/\/releases\/tag\/([^/?#]+)$/);
  return m ? release(decodeURIComponent(m[1]!), "redirect") : null;
}

/** Latest upstream release, or null when neither source answers. Never throws. */
export async function fetchLatestUpstreamRelease(): Promise<UpstreamRelease | null> {
  for (const source of [fromApi, fromRedirect]) {
    try {
      const rel = await source();
      if (rel) return rel;
    } catch {
      // network error, timeout, bad JSON: try the next source
    }
  }
  return null;
}

/** Parse a cached value; anything malformed → null (treated as a cache miss). */
export function parseCachedRelease(raw: string | null | undefined): UpstreamRelease | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<UpstreamRelease>;
    if (
      typeof d.version === "string" &&
      versionFromTag(d.version) &&
      typeof d.url === "string" &&
      typeof d.checkedAt === "string"
    ) {
      return {
        version: d.version,
        tag: `v${d.version}`,
        url: d.url,
        source: d.source === "redirect" ? "redirect" : "api",
        checkedAt: d.checkedAt,
      };
    }
  } catch {
    /* corrupt */
  }
  return null;
}

/** Fields added to the no-token answer of GET /api/config/update. */
export interface TokenlessUpdateFields {
  available: boolean;
  installedVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt?: string;
}

export function tokenlessUpdateFields(
  installedVersion: string,
  latest: UpstreamRelease | null
): TokenlessUpdateFields {
  if (!latest) return { available: false, installedVersion };
  return {
    available: compareVersions(latest.version, installedVersion) > 0,
    installedVersion,
    latestVersion: latest.version,
    releaseUrl: latest.url,
    checkedAt: latest.checkedAt,
  };
}
