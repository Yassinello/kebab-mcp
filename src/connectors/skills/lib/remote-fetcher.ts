import { lookup } from "node:dns/promises";
import type { Skill } from "../store";
import { replaceSkill } from "../store";
import { fetchWithByteCap } from "@/core/fetch-utils";

/**
 * Remote fetcher for skills that point at a GitHub raw / Gist / https URL.
 *
 * Rules:
 *   - HTTPS only
 *   - 10s fetch timeout
 *   - 500KB max body
 *   - text/markdown or text/plain preferred (tolerant)
 *   - on error: keep last-good cachedContent, record lastError
 */

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 500 * 1024;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface FetchRemoteResult {
  ok: boolean;
  content?: string;
  error?: string;
}

/** Check if an IPv4 literal or resolved IP string is in a blocked range. */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  // loopback 127/8
  if (a === 127) return true;
  // any 0.0.0.0/8
  if (a === 0) return true;
  // RFC1918
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // link-local 169.254/16 (includes 169.254.169.254 cloud metadata)
  if (a === 169 && b === 254) return true;
  // carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::") return true;
  // link-local fe80::/10
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  )
    return true;
  // ULA fc00::/7 (fc.. / fd..)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // IPv4-mapped ::ffff:x.y.z.w — delegate
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  return false;
}

/**
 * Validates a URL is safe to fetch from a server: https only, no loopback,
 * no private networks, no cloud metadata. Resolves DNS and rejects if the
 * resolved IP lands in a blocked range.
 */
async function validateRemoteUrl(url: string): Promise<{ ok: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "URL must use https://" };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return { ok: false, error: "Blocked hostname" };
  }
  // If host is an IP literal, check it directly.
  if (/^[0-9.]+$/.test(host)) {
    if (isBlockedIPv4(host)) return { ok: false, error: "Blocked IP literal" };
  } else if (host.includes(":")) {
    if (isBlockedIPv6(host)) return { ok: false, error: "Blocked IPv6 literal" };
  } else {
    // Hostname — resolve via DNS and check all addresses.
    try {
      const addrs = await lookup(host, { all: true });
      for (const a of addrs) {
        if (a.family === 4 && isBlockedIPv4(a.address)) {
          return { ok: false, error: "Hostname resolves to blocked network" };
        }
        if (a.family === 6 && isBlockedIPv6(a.address)) {
          return { ok: false, error: "Hostname resolves to blocked network" };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `DNS lookup failed: ${msg}` };
    }
  }
  return { ok: true };
}

const MAX_REDIRECTS = 5;

/**
 * Manual redirect handler that re-runs validateRemoteUrl on every Location
 * header before following. Without this, an attacker-controlled public URL
 * can 302 → http://169.254.169.254/ (cloud metadata) or any internal IP,
 * because fetch's built-in `redirect: "follow"` does not consult our
 * SSRF allowlist. CVE-class issue.
 */
export async function fetchRemote(url: string): Promise<FetchRemoteResult> {
  let currentUrl = url;
  let hops = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    while (hops <= MAX_REDIRECTS) {
      const guard = await validateRemoteUrl(currentUrl);
      if (!guard.ok) {
        // Generic error — don't leak which IP/host failed (helps attackers map internal networks).
        return { ok: false, error: "Blocked or unreachable URL" };
      }

      const result = await fetchWithByteCap(
        currentUrl,
        {
          signal: controller.signal,
          redirect: "manual",
          headers: {
            "User-Agent": "MyMCP-Skills/1.0",
            Range: `bytes=0-${MAX_BYTES - 1}`,
          },
        },
        MAX_BYTES
      );

      // Manual redirect handling: 3xx with a Location header → re-validate and loop.
      if (result.status >= 300 && result.status < 400 && result.location) {
        const next = new URL(result.location, currentUrl).toString();
        currentUrl = next;
        hops++;
        continue;
      }

      if (result.status !== 200 && result.status !== 206) {
        return { ok: false, error: `HTTP ${result.status}` };
      }
      if (result.truncated) {
        return { ok: false, error: `response exceeds ${MAX_BYTES} bytes` };
      }
      return { ok: true, content: result.text };
    }
    return { ok: false, error: `too many redirects (${MAX_REDIRECTS})` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Collapse low-level network errors into a generic message — internal
    // hostnames in error text would help SSRF probing.
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH/i.test(msg)) {
      return { ok: false, error: "Blocked or unreachable URL" };
    }
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Returns true if the cache is stale (or empty) and a refetch should happen. */
export function isStale(skill: Skill, ttlMs = DEFAULT_TTL_MS): boolean {
  if (skill.source.type !== "remote") return false;
  if (!skill.source.cachedAt) return true;
  const last = Date.parse(skill.source.cachedAt);
  if (Number.isNaN(last)) return true;
  return Date.now() - last > ttlMs;
}

/**
 * For remote skills: if TTL expired, kick off a background refresh and
 * return the skill as-is (stale wins during refetch). For inline skills:
 * returns the skill unchanged.
 */
export async function maybeRefreshRemote(skill: Skill): Promise<Skill> {
  if (skill.source.type !== "remote") return skill;
  // If never fetched, do a synchronous fetch so the first call has content.
  if (!skill.source.cachedContent) {
    return refreshNow(skill);
  }
  if (isStale(skill)) {
    // Fire-and-forget; swallow errors.
    refreshNow(skill).catch(() => {});
  }
  return skill;
}

/** Force a fetch, persist cache, return updated skill. */
export async function refreshNow(skill: Skill): Promise<Skill> {
  if (skill.source.type !== "remote") return skill;
  const result = await fetchRemote(skill.source.url);
  const now = new Date().toISOString();
  const next: Skill = {
    ...skill,
    updatedAt: now,
    source: result.ok
      ? {
          type: "remote",
          url: skill.source.url,
          cachedContent: result.content ?? "",
          cachedAt: now,
          lastError: undefined,
        }
      : {
          type: "remote",
          url: skill.source.url,
          cachedContent: skill.source.cachedContent,
          cachedAt: skill.source.cachedAt,
          lastError: result.error,
        },
  };
  await replaceSkill(next);
  return next;
}
