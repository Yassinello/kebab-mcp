/**
 * REL-02 (2026-11 audit): cross-lambda invalidation.
 *
 * Every serverless instance keeps in-process caches (hydrated credentials,
 * skills / API tools / custom tools snapshots). Before this, a change made
 * through one lambda (dashboard save, credential deletion) was only seen by
 * that lambda; the others kept serving stale — even deleted — credentials
 * until they were recycled.
 *
 * Writers bump a per-tenant revision counter in KV; readers compare it (at
 * most once every REV_READ_TTL_MS per lambda) and drop their caches when it
 * moved.
 */
import { getContextKVStore, getCurrentTenantId } from "./request-context";
import { toMsg } from "./error-utils";

export const CONFIG_REV_KEY = "kebab:rev:config";
const REV_READ_TTL_MS = 2_000;
const ROOT = "__root__";

const readCache = new Map<string, { at: number; rev: string }>();

function tenantKey(): string {
  return getCurrentTenantId() ?? ROOT;
}

/**
 * Current revision for the calling tenant ("0" when never bumped). Reads are
 * memoized for 2s per lambda so the hot path costs at most one KV GET per
 * tenant every 2s. A KV failure returns the last known value (or "0").
 */
export async function getConfigRevision(): Promise<string> {
  const key = tenantKey();
  const cached = readCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < REV_READ_TTL_MS) return cached.rev;
  try {
    const rev = (await getContextKVStore().get(CONFIG_REV_KEY)) ?? "0";
    readCache.set(key, { at: now, rev });
    return rev;
  } catch (err) {
    console.warn(`[Kebab MCP] config revision read failed: ${toMsg(err)}`);
    return cached?.rev ?? "0";
  }
}

/** Bump the calling tenant's revision. Never throws. */
export async function bumpConfigRevision(): Promise<void> {
  const key = tenantKey();
  readCache.delete(key);
  try {
    const kv = getContextKVStore();
    if (typeof kv.incr === "function") {
      await kv.incr(CONFIG_REV_KEY);
    } else {
      await kv.set(CONFIG_REV_KEY, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    }
  } catch (err) {
    console.warn(`[Kebab MCP] config revision bump failed: ${toMsg(err)}`);
  }
}

/** Test-only. */
export function __resetConfigRevisionCacheForTests(): void {
  readCache.clear();
}
