import type { Skill } from "../store";
import { replaceSkill } from "../store";

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

export async function fetchRemote(url: string): Promise<FetchRemoteResult> {
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, error: "URL must use https://" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "MyMCP-Skills/1.0" },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return { ok: false, error: `response exceeds ${MAX_BYTES} bytes` };
    }
    const text = new TextDecoder("utf-8").decode(buf);
    return { ok: true, content: text };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
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
