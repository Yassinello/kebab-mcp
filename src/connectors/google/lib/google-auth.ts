import { McpToolError, ErrorCode } from "@/core/errors";
import { getConfig } from "@/core/config-facade";
import { getContextKVStore } from "@/core/request-context";

interface CachedToken {
  access_token: string;
  expires_at: number;
}

// In-process LRU is still useful for warm-lambda hot path (sub-ms read).
// KV cache is the cross-lambda layer: a fresh lambda can borrow another
// lambda's still-valid token instead of hitting Google's token endpoint.
let cachedToken: CachedToken | null = null;

const KV_KEY = "google:oauth:access-token";
const REFRESH_MARGIN_MS = 300_000; // 5 min before expiry

async function readKvCachedToken(): Promise<CachedToken | null> {
  try {
    const kv = getContextKVStore();
    const raw = await kv.get(KV_KEY);
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

async function writeKvCachedToken(tok: CachedToken): Promise<void> {
  try {
    const kv = getContextKVStore();
    // TTL = (expiry - now) seconds; leave a 10-min cushion so a slightly
    // slow refetcher never finds an expired-but-still-cached token.
    const ttlMs = tok.expires_at - Date.now() - 600_000;
    if (ttlMs > 0) {
      await kv.set(KV_KEY, JSON.stringify(tok), Math.floor(ttlMs / 1000));
    }
  } catch {
    // KV unavailable (cold start, network blip): in-process cache still works.
  }
}

/** Test-only: reset the in-process token cache. */
export function __resetGoogleTokenCacheForTests(): void {
  cachedToken = null;
}

export async function getGoogleAccessToken(): Promise<string> {
  // L1: In-process cache (warm lambda, sub-ms)
  if (cachedToken && Date.now() < cachedToken.expires_at - REFRESH_MARGIN_MS) {
    return cachedToken.access_token;
  }

  // L2: KV cache (cold lambda but another lambda's token is still valid)
  // PERF-A-02: skips a 300–500ms Google OAuth roundtrip on every cold start
  // when at least one warm lambda has minted a token in the last ~55min.
  const kvHit = await readKvCachedToken();
  if (kvHit) {
    cachedToken = kvHit;
    return kvHit.access_token;
  }

  const clientId = getConfig("GOOGLE_CLIENT_ID");
  const clientSecret = getConfig("GOOGLE_CLIENT_SECRET");
  const refreshToken = getConfig("GOOGLE_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [
      !clientId && "GOOGLE_CLIENT_ID",
      !clientSecret && "GOOGLE_CLIENT_SECRET",
      !refreshToken && "GOOGLE_REFRESH_TOKEN",
    ].filter(Boolean);
    throw new McpToolError({
      code: ErrorCode.CONFIGURATION_ERROR,
      toolName: "google",
      message: `Missing env vars: ${missing.join(", ")}`,
      userMessage: `Google pack is not configured. Add ${missing.join(", ")} in your environment variables.`,
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
      message: `Google OAuth failed: ${oauthCode} — ${errorDesc}`,
      userMessage:
        userHints[oauthCode] ||
        `Google authentication failed (${oauthCode}). Check your GOOGLE_* environment variables.`,
      retryable: false,
    });
  }

  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };

  // Persist to KV so other lambdas skip the OAuth roundtrip.
  await writeKvCachedToken(cachedToken);

  return cachedToken.access_token;
}
