/**
 * Bootstrap rehydration for the proxy (formerly Edge middleware).
 *
 * `first-run.ts` pulls in the KV store, tracing and signing-secret
 * graph, too heavy for the proxy bundle. This module is a small subset:
 * it reads the first-run bootstrap directly from Upstash via the REST
 * API, or (D4, below) from the local files the bootstrap wrote.
 *
 * The goal is to close the consistency gap where middleware would see
 * `process.env.MCP_AUTH_TOKEN` as undefined on a fresh lambda (because
 * the handler rehydrates from KV at request time, but the middleware
 * runs first and has no such path), leading to spurious
 * `/config` → `/welcome` redirects on a fully-initialized instance.
 *
 * SEC-02 (v0.10): this module no longer mutates process.env at request
 * time. Instead it populates a module-scope edge cache that the
 * Edge-runtime auth check (`proxy.ts`) consults via
 * `getEdgeBootstrapAuthToken()`. This matches the Node runtime
 * pattern in `first-run.ts` (bootstrapAuthTokenCache).
 *
 * D4 (2026-11 audit): local and Docker instances without Upstash were
 * locked out after /welcome — the token was minted (MCP worked) but the
 * proxy only looked in Upstash, so /config kept redirecting to /welcome.
 * Since Next 16 the proxy runs on the Node.js runtime (see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md,
 * "Runtime"), so it can read what first-run/bootstrap.ts persisted on
 * disk: the filesystem KV (MYMCP_KV_PATH, default ./data/kv.json; off
 * Vercel only) and the 15-minute /tmp bootstrap file.
 *
 * Keep this file import-light: Web APIs, `node:fs`/`node:os`/`node:path`
 * only, no `@/core/*` imports (they would pull the whole KV / tracing
 * graph into the proxy bundle). `upstash-env.ts` is the only allowed
 * sibling import (pure process.env reads, no I/O — DUR-06). The paths and
 * key below mirror src/core/kv-store.ts and src/core/first-run/bootstrap.ts;
 * tests/core/first-run-edge-local.test.ts pins the parity.
 */

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getUpstashCreds } from "./upstash-env";

const KV_BOOTSTRAP_KEY = "mymcp:firstrun:bootstrap";
/** Same file and lifetime as BOOTSTRAP_PATH / BOOTSTRAP_TTL_MS in first-run/bootstrap.ts. */
const TMP_BOOTSTRAP_PATH = join(tmpdir(), ".mymcp-bootstrap.json");
const TMP_BOOTSTRAP_TTL_MS = 15 * 60 * 1000;

/**
 * SEC-02: in-memory edge cache for the bootstrap MCP_AUTH_TOKEN.
 * Replaces the pre-v0.10 `process.env.MCP_AUTH_TOKEN = ...` mutation
 * which was racy under interleaved edge requests.
 */
let edgeBootstrapAuthTokenCache: string | null = null;

/** Returns the Edge-runtime in-memory bootstrap token, if any. */
export function getEdgeBootstrapAuthToken(): string | null {
  return edgeBootstrapAuthTokenCache;
}

/** Test helper: forget the cached token (module state survives between tests). */
export function __resetEdgeBootstrapCacheForTests(): void {
  edgeBootstrapAuthTokenCache = null;
}

/** The token of a persisted bootstrap payload (a JSON string), or null when unusable. */
function tokenFromPayload(raw: string | null | undefined, maxAgeMs?: number): string | null {
  if (!raw) return null;
  // silent-swallow-ok: a malformed persisted payload is treated as "no bootstrap" (first-run flow continues), same as first-run/bootstrap.ts
  try {
    const parsed = JSON.parse(raw) as { token?: unknown; createdAt?: unknown };
    if (typeof parsed.token !== "string" || parsed.token.length < 10) return null;
    if (maxAgeMs !== undefined) {
      if (typeof parsed.createdAt !== "number" || Date.now() - parsed.createdAt > maxAgeMs) {
        return null;
      }
    }
    return parsed.token;
  } catch {
    return null;
  }
}

/**
 * D4: the bootstrap token persisted on this machine by first-run/bootstrap.ts,
 * for instances without Upstash. The filesystem KV is only durable off
 * Vercel (same rule as kv-store.ts / isExternalKvAvailable); the /tmp file
 * is honoured everywhere within its 15-minute lifetime.
 */
async function readLocalBootstrapToken(): Promise<string | null> {
  if (process.env.VERCEL !== "1") {
    const kvPath = process.env.MYMCP_KV_PATH?.trim() || resolve(process.cwd(), "data", "kv.json");
    // silent-swallow-ok: no KV file yet (fresh install) or unreadable — fall through to /tmp, then to the first-run redirect
    try {
      const map = JSON.parse(await readFile(kvPath, "utf-8")) as Record<string, unknown>;
      const value = map?.[KV_BOOTSTRAP_KEY];
      const token = tokenFromPayload(typeof value === "string" ? value : null);
      if (token) return token;
    } catch {
      // fall through
    }
  }
  // silent-swallow-ok: missing /tmp bootstrap is the normal state before /welcome
  try {
    return tokenFromPayload(await readFile(TMP_BOOTSTRAP_PATH, "utf-8"), TMP_BOOTSTRAP_TTL_MS);
  } catch {
    return null;
  }
}

/**
 * If `process.env.MCP_AUTH_TOKEN` is missing on the current lambda and
 * Upstash is configured, fetch the persisted bootstrap and populate the
 * module-scope edge cache (NOT process.env — SEC-02). Swallows all
 * errors — middleware must never break page serving.
 *
 * On warm lambdas the first check short-circuits, so the Upstash call
 * only fires once per lambda lifetime (or never, if the platform already
 * injected MCP_AUTH_TOKEN via real env vars).
 */
export async function ensureBootstrapRehydratedFromUpstash(): Promise<void> {
  if (process.env.MCP_AUTH_TOKEN) return;
  if (edgeBootstrapAuthTokenCache) return;
  // DUR-06: supports both env var schemes — the legacy "Upstash for Vercel"
  // integration injects UPSTASH_REDIS_REST_URL/TOKEN, while the newer
  // Vercel Marketplace Upstash KV product injects KV_REST_API_URL/TOKEN.
  // `getUpstashCreds()` in upstash-env.ts resolves both and prefers
  // UPSTASH_* when both are set.
  const creds = getUpstashCreds();
  if (!creds) {
    // D4: no Upstash — look at what the filesystem bootstrap persisted.
    // A miss is not cached: the token may be minted on the next request.
    edgeBootstrapAuthTokenCache = await readLocalBootstrapToken();
    return;
  }
  const { url, token } = creds;
  try {
    // Use the POST-with-command-array form rather than the GET-style
    // path endpoint. The key (`mymcp:firstrun:bootstrap`) contains
    // colons that some Upstash gateway revisions treat as URL-reserved
    // and 404 on, even though they were originally written via the
    // POST form by `UpstashKV` in `kv-store.ts`. Aligning the two paths
    // is the safer option.
    const res = await fetch(url.replace(/\/$/, ""), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["GET", KV_BOOTSTRAP_KEY]),
      // A second is plenty for a Redis GET on the same region; if it
      // takes longer than that, fall through to first-time-setup rather
      // than block the page.
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return;
    const json = (await res.json()) as { result?: string | null };
    if (!json.result) return;
    const parsed = JSON.parse(json.result) as {
      token?: unknown;
      claimId?: unknown;
      createdAt?: unknown;
    };
    if (typeof parsed.token !== "string" || parsed.token.length < 10) return;
    edgeBootstrapAuthTokenCache = parsed.token;
  } catch {
    // silent-swallow-ok: Edge-runtime rehydrate is best-effort — network hiccup, malformed payload, or 1s timeout falls back to existing first-time-setup logic without breaking middleware; logging here would require an Edge-compatible logger that depends on process.env reads already confirmed to work above
  }
}
