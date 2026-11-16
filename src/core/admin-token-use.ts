/**
 * Audit 2026-11 (A2, contract 2) — notice when an AI client talks to the MCP
 * endpoint with the instance's admin key.
 *
 * When `ADMIN_AUTH_TOKEN` is not set separately, the dashboard accepts the
 * MCP token (or the welcome-minted bootstrap token). A client holding that
 * token can open the dashboard and change devices. We do not refuse such
 * calls (that would break existing setups); we record the last time it
 * happened so the dashboard can warn the owner:
 *
 *   KV `security:admin-token-mcp-last` → ISO timestamp (throttled, 1/hour)
 *
 * The token set mirrors `checkAdminAuth` in auth.ts (which this module must
 * not change): `ADMIN_AUTH_TOKEN || MCP_AUTH_TOKEN || bootstrap token`, with
 * the production refusal of the MCP fallback unless explicitly opted in.
 */

import { getConfig } from "./config-facade";
import { getContextKVStore } from "./request-context";
import { runAfterResponse } from "./after-response";

export const ADMIN_TOKEN_MCP_LAST_KEY = "security:admin-token-mcp-last";

const THROTTLE_MS = 60 * 60 * 1000;

let lastRecordedAt = 0;

/** Test-only: reset the in-process throttle. */
export function __resetAdminTokenUseForTests(): void {
  lastRecordedAt = 0;
}

/** Token ids that also open the dashboard (same resolution as checkAdminAuth). */
export async function adminTokenIds(): Promise<Set<string>> {
  const adminEnv = getConfig("ADMIN_AUTH_TOKEN");
  const mcpEnv = getConfig("MCP_AUTH_TOKEN");
  const fallback = getConfig("KEBAB_ADMIN_TOKEN_FALLBACK");
  const fallbackOptIn = fallback === "1" || fallback === "true";
  const isProd = getConfig("NODE_ENV") === "production" || getConfig("VERCEL") === "1";
  // checkAdminAuth answers 503 in this configuration: the MCP token does
  // not open the dashboard.
  if (isProd && !adminEnv && mcpEnv && !fallbackOptIn) return new Set();
  // Loaded lazily: auth/first-run pull logging and bootstrap state that the
  // transport module must not load eagerly.
  const [{ parseTokens, tokenId }, { getBootstrapAuthToken }] = await Promise.all([
    import("./auth"),
    import("./first-run"),
  ]);
  const raw = adminEnv || mcpEnv || getBootstrapAuthToken() || "";
  return new Set(parseTokens(raw).map(tokenId));
}

/** True when this MCP caller authenticated with a token that also opens the dashboard. */
export async function isAdminTokenId(callerTokenId: string | null | undefined): Promise<boolean> {
  if (!callerTokenId) return false;
  try {
    return (await adminTokenIds()).has(callerTokenId);
  } catch {
    return false;
  }
}

/**
 * Record, after the response, that an MCP request used the admin key — at
 * most once per hour (in-process and in KV). Never throws, never delays
 * the response.
 */
export function noteAdminTokenMcpUse(callerTokenId: string | null | undefined): void {
  if (!callerTokenId) return;
  if (Date.now() - lastRecordedAt < THROTTLE_MS) return;
  let kv: ReturnType<typeof getContextKVStore>;
  try {
    kv = getContextKVStore();
  } catch {
    return;
  }
  // fire-and-forget OK: observational marker for the dashboard warning; runAfterResponse logs failures
  runAfterResponse(async () => {
    if (!(await isAdminTokenId(callerTokenId))) return;
    const now = Date.now();
    if (now - lastRecordedAt < THROTTLE_MS) return;
    lastRecordedAt = now;
    const prev = await kv.get(ADMIN_TOKEN_MCP_LAST_KEY);
    const prevAt = prev ? Date.parse(prev) : NaN;
    if (Number.isFinite(prevAt) && now - prevAt < THROTTLE_MS) return;
    await kv.set(ADMIN_TOKEN_MCP_LAST_KEY, new Date(now).toISOString());
  }, "security.adminTokenMcpUse");
}
