import { McpToolError, ErrorCode } from "@/core/errors";
import { getContextKVStore } from "@/core/request-context";
import type { AccountTokenSet } from "@/core/connector-accounts";

/**
 * Per-account auth context threaded through every Google API call.
 *
 * Google differs from Slack/Notion (static bearer): it holds a 3-tuple
 * `{ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN }` that
 * mints a SHORT-LIVED access token. Each account's refresh token mints a
 * distinct access token, so the access-token cache (L1 + L2) is keyed by
 * the account `slug` to prevent cross-account contamination.
 */
export interface GoogleAuthContext {
  tokens: AccountTokenSet;
  slug: string;
}

interface CachedToken {
  access_token: string;
  expires_at: number;
}

// L1 in-process cache, keyed by account slug. Still useful for the warm-lambda
// hot path (sub-ms read). The L2 KV cache is the cross-lambda layer: a fresh
// lambda can borrow another lambda's still-valid token instead of hitting
// Google's token endpoint.
const tokenCache = new Map<string, CachedToken>();

const KV_KEY_PREFIX = "google:oauth:access-token";
const REFRESH_MARGIN_MS = 300_000; // 5 min before expiry

/** Per-account KV cache key — each account mints a distinct access token. */
function kvKey(slug: string): string {
  return `${KV_KEY_PREFIX}:${slug}`;
}

async function readKvCachedToken(slug: string): Promise<CachedToken | null> {
  try {
    const kv = getContextKVStore();
    const raw = await kv.get(kvKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedToken;
    if (
      typeof parsed.access_token === "string" &&
      typeof parsed.expires_at === "number" &&
      Date.now() < parsed.expires_at - REFRESH_MARGIN_MS
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeKvCachedToken(slug: string, tok: CachedToken): Promise<void> {
  // Race note: under concurrent cold-start load, two lambdas can both miss the
  // KV cache and refresh in parallel, then both write here. The second write
  // overwrites the first with an equivalently-valid token (Google issues
  // the same access_token to multiple refresh calls within a short window).
  // The only cost is the extra OAuth roundtrip (~300ms), incurred once per
  // burst — acceptable. Compare-and-set would require a KV primitive the
  // FilesystemKV backend doesn't expose; not worth the complexity.
  try {
    const kv = getContextKVStore();
    // TTL = (expiry - now) seconds; leave a 10-min cushion so a slightly
    // slow refetcher never finds an expired-but-still-cached token.
    const ttlMs = tok.expires_at - Date.now() - 600_000;
    if (ttlMs > 0) {
      await kv.set(kvKey(slug), JSON.stringify(tok), Math.floor(ttlMs / 1000));
    }
  } catch {
    // KV unavailable (cold start, network blip): in-process cache still works.
  }
}

/**
 * Evict one account's minted access token from both cache layers. Called when
 * an account is saved or removed, so a re-saved slug (same name, new refresh
 * token) never serves a stale derived access token.
 */
export async function evictGoogleTokenCache(slug: string): Promise<void> {
  tokenCache.delete(slug);
  try {
    const kv = getContextKVStore();
    await kv.delete(kvKey(slug));
  } catch {
    // KV unavailable: the L1 entry is gone and the L2 entry will expire via TTL.
  }
}

/** Test-only: reset the in-process token cache. */
export function __resetGoogleTokenCacheForTests(): void {
  tokenCache.clear();
}

export async function getGoogleAccessToken(ctx: GoogleAuthContext): Promise<string> {
  const { tokens, slug } = ctx;

  // L1: In-process cache (warm lambda, sub-ms), per account slug.
  const l1 = tokenCache.get(slug);
  if (l1 && Date.now() < l1.expires_at - REFRESH_MARGIN_MS) {
    return l1.access_token;
  }

  // L2: KV cache (cold lambda but another lambda's token is still valid).
  // PERF-A-02: skips a 300–500ms Google OAuth roundtrip on every cold start
  // when at least one warm lambda has minted a token in the last ~55min.
  const kvHit = await readKvCachedToken(slug);
  if (kvHit) {
    tokenCache.set(slug, kvHit);
    return kvHit.access_token;
  }

  const clientId = tokens.GOOGLE_CLIENT_ID;
  const clientSecret = tokens.GOOGLE_CLIENT_SECRET;
  const refreshToken = tokens.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [
      !clientId && "GOOGLE_CLIENT_ID",
      !clientSecret && "GOOGLE_CLIENT_SECRET",
      !refreshToken && "GOOGLE_REFRESH_TOKEN",
    ].filter(Boolean);
    throw new McpToolError({
      code: ErrorCode.CONFIGURATION_ERROR,
      toolName: "google",
      message: `Missing credentials for account "${slug}": ${missing.join(", ")}`,
      userMessage: `Google account "${slug}" is missing ${missing.join(", ")}. Reconnect it in /config → Connectors.`,
      retryable: false,
    });
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();

  if (!data.access_token) {
    const oauthCode = data.error || "unknown";
    const errorDesc = data.error_description || "";

    const userHints: Record<string, string> = {
      invalid_client:
        "OAuth client does not exist or was deleted. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      invalid_grant:
        "Refresh token was revoked or expired. Re-authenticate via /config → Connectors and update GOOGLE_REFRESH_TOKEN.",
      unauthorized_client: "OAuth client is not authorized for this grant type.",
      invalid_scope: "One or more scopes are not authorized. Check OAuth consent screen scopes.",
    };

    throw new McpToolError({
      code: ErrorCode.AUTH_FAILED,
      toolName: "google",
      message: `Google OAuth failed for account "${slug}": ${oauthCode} — ${errorDesc}`,
      userMessage:
        userHints[oauthCode] ||
        `Google authentication failed (${oauthCode}). Reconnect the "${slug}" account in /config → Connectors.`,
      retryable: false,
    });
  }

  const minted: CachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  tokenCache.set(slug, minted);

  // Persist to KV so other lambdas skip the OAuth roundtrip.
  await writeKvCachedToken(slug, minted);

  return minted.access_token;
}
