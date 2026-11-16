/**
 * Kebab House phase 1 (OAU-01..10) — a single-owner OAuth 2.1 authorization
 * server for the MCP endpoint.
 *
 * Model: the instance owner is the only resource owner. An MCP client
 * (Claude, Cursor, ChatGPT…) registers (DCR) or identifies itself with a
 * Client ID Metadata Document (CIMD), the owner approves it on
 * /oauth/authorize (admin session), and the client receives an opaque
 * access token (1 h) + rotating refresh token (30 days). Each authorized
 * client becomes a *device* (`devices:<id>` entry, `oauth` marker) so every
 * existing per-token feature — connector scope, skill tags, profile, usage
 * counters, revocation — applies unchanged.
 *
 * Storage (root namespace only — OAuth is not tenant-aware in this phase):
 *   oauth:client:<client_id>     DCR client record (24 h until first authorization, then 1 year)
 *   oauth:cimd:<sha256(url)>     cached CIMD document (24 h)
 *   oauth:code:<sha256(code)>    authorization code (single use, 120 s)
 *   oauth:at:<sha256(token)>     access token (1 h)
 *   oauth:rt:<sha256(token)>     refresh token (30 days, rotated)
 *   oauth:family:<id>:revoked    refresh family revoked after reuse
 * Only SHA-256 hashes of codes and tokens are stored.
 *
 * Audit 2026-11 (A3): registration is capped (metadata size, number of
 * clients, short TTL until a first authorization), a refresh token retried
 * within a short grace window no longer revokes its family, the device is
 * created (or the client's existing device reused) only once the code is
 * exchanged, and native-app custom-scheme redirect URIs are accepted.
 */

import { createHash, randomBytes } from "node:crypto";
import { getKVStore, kvScanAll } from "./kv-store";
import { safeFetch } from "./safe-fetch";
import { getConfig } from "./config-facade";
import { toMsg } from "./error-utils";

export const OAUTH_SCOPE = "mcp";
export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
export const CODE_TTL_S = 120;
const CIMD_TTL_S = 24 * 60 * 60;
const CLIENT_TTL_S = 365 * 24 * 60 * 60;
/** A registered client that never completed an authorization expires after a day. */
export const PENDING_CLIENT_TTL_S = 24 * 60 * 60;
/** Largest accepted registration request (JSON metadata), in bytes. */
export const MAX_CLIENT_METADATA_BYTES = 4 * 1024;
/** Most registered (DCR) clients kept at once. */
export const MAX_REGISTERED_CLIENTS = 500;
/**
 * A rotated refresh token presented again within this window (a client
 * retrying after a lost response) is refused without revoking its family.
 */
export const REFRESH_REUSE_GRACE_S = 60;

export class OAuthError extends Error {
  constructor(
    readonly error:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "unauthorized_client"
      | "unsupported_grant_type"
      | "invalid_scope"
      | "invalid_target"
      | "invalid_redirect_uri"
      | "invalid_client_metadata"
      | "access_denied"
      | "temporarily_unavailable",
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "OAuthError";
  }
  toJSON() {
    return { error: this.error, error_description: this.message };
  }
}

// ── helpers ──────────────────────────────────────────────────────────

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

/** Public origin of this instance: KEBAB_PUBLIC_URL override, else the request URL. */
export function publicOrigin(request: Request): string {
  const override = getConfig("KEBAB_PUBLIC_URL")?.trim();
  if (override) {
    try {
      return new URL(override).origin;
    } catch {
      // fall through to the request URL
    }
  }
  return new URL(request.url).origin;
}

export function mcpResourceUrl(origin: string): string {
  return `${origin}/api/mcp`;
}

/** S256 PKCE check (RFC 7636). */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return b64url(createHash("sha256").update(verifier).digest()) === challenge;
}

/**
 * Schemes never accepted as a redirect target: they run code, read local
 * files, or are not an app callback at all.
 */
const FORBIDDEN_REDIRECT_SCHEMES: ReadonlySet<string> = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "about:",
  "blob:",
  "filesystem:",
  "view-source:",
  "ws:",
  "wss:",
  "ftp:",
  "mailto:",
  "tel:",
  "sms:",
]);

/** True for a private-use URI scheme of a native app (RFC 8252 §7.1), e.g. `cursor:`. */
export function isCustomSchemeRedirect(raw: string): boolean {
  try {
    const p = new URL(raw).protocol;
    return p !== "https:" && p !== "http:" && !FORBIDDEN_REDIRECT_SCHEMES.has(p);
  } catch {
    return false;
  }
}

/**
 * Accepted redirect URIs: https; http on a loopback address (any port, CLI
 * clients); or a native app's private-use scheme (`cursor://…`,
 * `vscode://…`, `com.example.app:/cb`). Never javascript:, data:, file:,
 * vbscript:, about:, blob: and the like, nor plain http to another host.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  if (typeof raw !== "string" || raw.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  }
  if (FORBIDDEN_REDIRECT_SCHEMES.has(u.protocol)) return false;
  // Private-use scheme: a plain scheme name, and something after it.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && raw.length > u.protocol.length + 1;
}

/**
 * Loopback redirect URIs match regardless of port (RFC 8252 §7.3);
 * everything else must match exactly.
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    const loop = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "[::1]";
    return (
      a.protocol === "http:" &&
      b.protocol === "http:" &&
      loop(a.hostname) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

// ── clients ──────────────────────────────────────────────────────────

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  /** `dcr` = registered here; `cimd` = metadata document at client_id URL. */
  kind: "dcr" | "cimd";
  client_uri?: string;
  logo_uri?: string;
  /** DCR: epoch seconds of registration. */
  registered_at?: number;
  /** DCR: true once an authorization code was exchanged (then kept 1 year). */
  authorized?: boolean;
}

function cleanName(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : fallback;
}

function parseClientRecord(raw: string | null): OAuthClient | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as OAuthClient;
    return c && typeof c === "object" && typeof c.client_id === "string" ? c : null;
  } catch {
    return null;
  }
}

/** A DCR client that never completed an authorization and is past its 24 h. */
function isStalePendingClient(c: OAuthClient, nowS: number): boolean {
  return (
    c.kind === "dcr" &&
    c.authorized !== true &&
    typeof c.registered_at === "number" &&
    nowS - c.registered_at > PENDING_CLIENT_TTL_S
  );
}

/**
 * Keep the number of registered clients bounded: when the cap is reached,
 * drop stale or never-authorized clients (oldest first); if every client
 * was authorized, refuse the new registration.
 */
async function makeRoomForClient(): Promise<void> {
  const kv = getKVStore();
  const keys = await kvScanAll(kv, "oauth:client:*");
  if (keys.length < MAX_REGISTERED_CLIENTS) return;
  const nowS = Math.floor(Date.now() / 1000);
  const records = await Promise.all(
    keys.map(async (key) => ({ key, c: parseClientRecord(await kv.get(key)) }))
  );
  const live: { key: string; c: OAuthClient }[] = [];
  for (const r of records) {
    // Unreadable records and expired pending clients never count.
    if (!r.c || isStalePendingClient(r.c, nowS)) await kv.delete(r.key);
    else live.push({ key: r.key, c: r.c });
  }
  let excess = live.length - MAX_REGISTERED_CLIENTS + 1;
  const unused = live
    .filter(({ c }) => c.authorized !== true)
    .sort((a, b) => (a.c.registered_at ?? 0) - (b.c.registered_at ?? 0));
  for (const r of unused) {
    if (excess <= 0) break;
    await kv.delete(r.key);
    excess -= 1;
  }
  if (excess > 0) {
    throw new OAuthError(
      "temporarily_unavailable",
      "too many registered clients; revoke unused ones in the dashboard and try again",
      429
    );
  }
}

/** OAU-04 — Dynamic Client Registration (public clients only). */
export async function registerClient(meta: Record<string, unknown>): Promise<OAuthClient> {
  if (Buffer.byteLength(JSON.stringify(meta), "utf8") > MAX_CLIENT_METADATA_BYTES) {
    throw new OAuthError(
      "invalid_client_metadata",
      `client metadata must be at most ${MAX_CLIENT_METADATA_BYTES} bytes`
    );
  }
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1 to 10 URIs");
  }
  for (const u of uris) {
    if (typeof u !== "string" || !isAllowedRedirectUri(u)) {
      throw new OAuthError(
        "invalid_redirect_uri",
        "redirect URIs must be https, http on a loopback address, or an app's own scheme"
      );
    }
  }
  const method = meta.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    throw new OAuthError(
      "invalid_client_metadata",
      "only public clients are supported (token_endpoint_auth_method=none)"
    );
  }
  const client: OAuthClient = {
    client_id: `kc_${randomToken(16)}`,
    client_name: cleanName(meta.client_name, "MCP client"),
    redirect_uris: uris as string[],
    kind: "dcr",
    registered_at: Math.floor(Date.now() / 1000),
    authorized: false,
  };
  if (typeof meta.client_uri === "string") client.client_uri = meta.client_uri.slice(0, 300);
  await makeRoomForClient();
  await getKVStore().set(
    `oauth:client:${client.client_id}`,
    JSON.stringify(client),
    PENDING_CLIENT_TTL_S
  );
  return client;
}

/** After a first successful authorization, keep a DCR client for the long TTL. */
async function markClientAuthorized(clientId: string): Promise<void> {
  if (isCimdClientId(clientId)) return;
  const kv = getKVStore();
  const key = `oauth:client:${clientId}`;
  const c = parseClientRecord(await kv.get(key));
  if (!c || c.authorized === true) return;
  await kv.set(key, JSON.stringify({ ...c, authorized: true }), CLIENT_TTL_S);
}

function isCimdClientId(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    return u.protocol === "https:" && u.pathname !== "/" && !u.hash;
  } catch {
    return false;
  }
}

/** OAU-05 — fetch, validate and cache a Client ID Metadata Document. */
async function resolveCimdClient(clientId: string): Promise<OAuthClient> {
  const kv = getKVStore();
  const cacheKey = `oauth:cimd:${sha256(clientId)}`;
  const cached = await kv.get(cacheKey);
  if (cached) {
    try {
      const c = JSON.parse(cached) as OAuthClient & { cachedAt?: number };
      if (typeof c.cachedAt === "number" && Date.now() - c.cachedAt < CIMD_TTL_S * 1000) {
        const { cachedAt: _cachedAt, ...client } = c;
        return client;
      }
    } catch {
      // refetch
    }
  }
  let doc: Record<string, unknown>;
  try {
    const { response } = await safeFetch(
      clientId,
      { headers: { accept: "application/json" } },
      { timeoutMs: 5000, maxRedirects: 0 }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 16 * 1024) throw new Error("document too large");
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new OAuthError(
      "invalid_client",
      `could not load the client metadata document: ${toMsg(err)}`,
      401
    );
  }
  if (doc.client_id !== clientId) {
    throw new OAuthError(
      "invalid_client",
      "client_id in the metadata document does not match",
      401
    );
  }
  const uris = Array.isArray(doc.redirect_uris)
    ? (doc.redirect_uris as unknown[]).filter(
        (u): u is string => typeof u === "string" && isAllowedRedirectUri(u)
      )
    : [];
  if (uris.length === 0) {
    throw new OAuthError(
      "invalid_client",
      "the metadata document lists no valid redirect_uris",
      401
    );
  }
  const client: OAuthClient = {
    client_id: clientId,
    client_name: cleanName(doc.client_name, new URL(clientId).host),
    redirect_uris: uris,
    kind: "cimd",
  };
  if (typeof doc.client_uri === "string") client.client_uri = doc.client_uri.slice(0, 300);
  if (typeof doc.logo_uri === "string") client.logo_uri = doc.logo_uri.slice(0, 300);
  await kv.set(cacheKey, JSON.stringify({ ...client, cachedAt: Date.now() }), CIMD_TTL_S);
  return client;
}

export async function getClient(clientId: string): Promise<OAuthClient> {
  if (!clientId || clientId.length > 500) {
    throw new OAuthError("invalid_client", "unknown client", 401);
  }
  if (isCimdClientId(clientId)) return resolveCimdClient(clientId);
  const c = parseClientRecord(await getKVStore().get(`oauth:client:${clientId}`));
  // The filesystem KV ignores TTLs: enforce the 24 h of a pending client here.
  if (!c || isStalePendingClient(c, Math.floor(Date.now() / 1000))) {
    throw new OAuthError("invalid_client", "unknown client", 401);
  }
  return c;
}

// ── authorization request validation ─────────────────────────────────

export interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string | undefined;
  scope?: string | undefined;
  resource?: string | undefined;
}

export interface ValidatedAuthorize {
  client: OAuthClient;
  redirect_uri: string;
  code_challenge: string;
  state: string | undefined;
  resource: string;
}

export function readAuthorizeParams(sp: URLSearchParams): AuthorizeParams {
  const g = (k: string) => sp.get(k) ?? "";
  return {
    response_type: g("response_type"),
    client_id: g("client_id"),
    redirect_uri: g("redirect_uri"),
    code_challenge: g("code_challenge"),
    code_challenge_method: g("code_challenge_method"),
    state: sp.get("state") ?? undefined,
    scope: sp.get("scope") ?? undefined,
    resource: sp.get("resource") ?? undefined,
  };
}

/**
 * Validate an authorization request. Client / redirect errors must NOT be
 * redirected (the redirect target is not trusted yet): they throw.
 */
export async function validateAuthorize(
  p: AuthorizeParams,
  origin: string
): Promise<ValidatedAuthorize> {
  const client = await getClient(p.client_id);
  const registered = client.redirect_uris.find((r) => redirectUriMatches(r, p.redirect_uri));
  if (!registered) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uri is not registered for this client");
  }
  if (p.response_type !== "code") {
    throw new OAuthError("invalid_request", "response_type must be code");
  }
  if (p.code_challenge_method !== "S256" || !/^[A-Za-z0-9\-_]{43}$/.test(p.code_challenge)) {
    throw new OAuthError("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  if (p.scope && !p.scope.split(/\s+/).every((s) => s === OAUTH_SCOPE || s === "")) {
    throw new OAuthError("invalid_scope", `only the "${OAUTH_SCOPE}" scope is supported`);
  }
  const resource = mcpResourceUrl(origin);
  if (p.resource && p.resource.replace(/\/$/, "") !== resource) {
    throw new OAuthError("invalid_target", `resource must be ${resource}`);
  }
  return {
    client,
    redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge,
    state: p.state,
    resource,
  };
}

// ── codes and tokens ─────────────────────────────────────────────────

/**
 * The owner's consent, applied to the client's device when the code is
 * exchanged (audit 2026-11, A3) — so an abandoned authorization leaves no
 * device behind, and a re-authorization updates the client's device.
 */
export interface PendingDevice {
  label: string;
  clientName: string;
  skillTags: string[] | null;
  profile: string | null;
  access: "read" | "memory" | "full";
}

interface CodeRecord {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  deviceId: string;
  /** Device settings to apply on exchange; absent = the device already exists. */
  device?: PendingDevice;
  /** Epoch seconds — enforced in code because the filesystem KV ignores TTLs. */
  exp: number;
}

export async function issueCode(
  v: ValidatedAuthorize,
  deviceId: string,
  device?: PendingDevice
): Promise<string> {
  const code = randomToken(32);
  const rec: CodeRecord = {
    client_id: v.client.client_id,
    redirect_uri: v.redirect_uri,
    code_challenge: v.code_challenge,
    resource: v.resource,
    deviceId,
    ...(device ? { device } : {}),
    exp: Math.floor(Date.now() / 1000) + CODE_TTL_S,
  };
  await getKVStore().set(`oauth:code:${sha256(code)}`, JSON.stringify(rec), CODE_TTL_S);
  return code;
}

interface TokenRecord {
  deviceId: string;
  clientId: string;
  familyId: string;
  exp: number;
  used?: boolean;
  /** Epoch seconds of the rotation (refresh tokens). */
  usedAt?: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokens(
  deviceId: string,
  clientId: string,
  familyId: string
): Promise<TokenResponse> {
  const kv = getKVStore();
  const at = randomToken(32);
  const rt = randomToken(32);
  const now = Math.floor(Date.now() / 1000);
  const atRec: TokenRecord = { deviceId, clientId, familyId, exp: now + ACCESS_TOKEN_TTL_S };
  const rtRec: TokenRecord = { deviceId, clientId, familyId, exp: now + REFRESH_TOKEN_TTL_S };
  await kv.set(`oauth:at:${sha256(at)}`, JSON.stringify(atRec), ACCESS_TOKEN_TTL_S);
  await kv.set(`oauth:rt:${sha256(rt)}`, JSON.stringify(rtRec), REFRESH_TOKEN_TTL_S);
  return {
    access_token: at,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: rt,
    scope: OAUTH_SCOPE,
  };
}

/** OAU-07 — authorization_code grant. */
export async function exchangeCode(p: {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
  resource?: string | undefined;
}): Promise<TokenResponse> {
  const kv = getKVStore();
  const key = `oauth:code:${sha256(p.code)}`;
  const raw = await kv.get(key);
  // Single use: delete before any further check so a replay never succeeds.
  if (raw) await kv.delete(key);
  if (!raw) throw new OAuthError("invalid_grant", "authorization code is invalid or expired");
  const rec = JSON.parse(raw) as CodeRecord;
  if (rec.exp < Math.floor(Date.now() / 1000)) {
    throw new OAuthError("invalid_grant", "authorization code is invalid or expired");
  }
  if (rec.client_id !== p.client_id) {
    throw new OAuthError("invalid_grant", "code was issued to another client");
  }
  if (rec.redirect_uri !== p.redirect_uri) {
    throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
  }
  if (!verifyPkce(p.code_verifier, rec.code_challenge)) {
    throw new OAuthError("invalid_grant", "PKCE verification failed");
  }
  if (p.resource && p.resource.replace(/\/$/, "") !== rec.resource) {
    throw new OAuthError("invalid_target", "resource does not match the authorization request");
  }
  let deviceId = rec.deviceId;
  if (rec.device) {
    // Loaded lazily: devices.ts pulls the connector registry, which must not
    // load with the auth pipeline that imports this module.
    const { applyOAuthConsent } = await import("./devices");
    deviceId = await applyOAuthConsent({
      ...rec.device,
      clientId: rec.client_id,
      fallbackId: rec.deviceId,
    });
  }
  await markClientAuthorized(rec.client_id);
  return issueTokens(deviceId, rec.client_id, randomToken(12));
}

async function familyRevoked(familyId: string): Promise<boolean> {
  return (await getKVStore().get(`oauth:family:${familyId}:revoked`)) !== null;
}

/** OAU-07 — refresh_token grant with rotation and reuse detection. */
export async function refreshTokens(p: {
  refresh_token: string;
  client_id: string;
}): Promise<TokenResponse> {
  const kv = getKVStore();
  const key = `oauth:rt:${sha256(p.refresh_token)}`;
  const raw = await kv.get(key);
  if (!raw) throw new OAuthError("invalid_grant", "refresh token is invalid or expired");
  const rec = JSON.parse(raw) as TokenRecord;
  if (rec.clientId !== p.client_id) {
    throw new OAuthError("invalid_grant", "refresh token was issued to another client");
  }
  if (rec.exp < Math.floor(Date.now() / 1000)) {
    throw new OAuthError("invalid_grant", "refresh token is invalid or expired");
  }
  const now = Math.floor(Date.now() / 1000);
  if (await familyRevoked(rec.familyId)) {
    throw new OAuthError("invalid_grant", "refresh token was already used; please sign in again");
  }
  if (rec.used) {
    // A retry right after a rotation (lost response, parallel refresh) is
    // refused but does not end the session of the client holding the new
    // tokens.
    if (typeof rec.usedAt === "number" && now - rec.usedAt <= REFRESH_REUSE_GRACE_S) {
      throw new OAuthError(
        "invalid_grant",
        "refresh token was just rotated; use the refresh token from the latest response"
      );
    }
    // Reuse of a rotated token outside the grace window: assume theft,
    // revoke the whole family.
    await kv.set(`oauth:family:${rec.familyId}:revoked`, "1", REFRESH_TOKEN_TTL_S);
    throw new OAuthError("invalid_grant", "refresh token was already used; please sign in again");
  }
  if (!(await deviceActive(rec.deviceId))) {
    throw new OAuthError("invalid_grant", "this client was revoked in the dashboard");
  }
  const remaining = Math.max(1, rec.exp - now);
  await kv.set(key, JSON.stringify({ ...rec, used: true, usedAt: now }), remaining);
  return issueTokens(rec.deviceId, rec.clientId, rec.familyId);
}

/** OAU-09 — revoke an access or refresh token (RFC 7009: always 200). */
export async function revokeToken(token: string): Promise<void> {
  const kv = getKVStore();
  const h = sha256(token);
  for (const prefix of ["oauth:at:", "oauth:rt:"]) {
    const raw = await kv.get(`${prefix}${h}`);
    if (!raw) continue;
    await kv.delete(`${prefix}${h}`);
    try {
      const rec = JSON.parse(raw) as TokenRecord;
      if (prefix === "oauth:rt:") {
        await kv.set(`oauth:family:${rec.familyId}:revoked`, "1", REFRESH_TOKEN_TTL_S);
      }
    } catch {
      // nothing else to revoke
    }
  }
}

// ── devices ──────────────────────────────────────────────────────────

/** Device ids of OAuth clients: 8 hex chars, same shape as tokenId(). */
export function newOAuthDeviceId(): string {
  return randomBytes(4).toString("hex");
}

async function deviceActive(deviceId: string): Promise<boolean> {
  const raw = await getKVStore().get(`devices:${deviceId}`);
  if (!raw) return false;
  try {
    const e = JSON.parse(raw) as { revokedAt?: unknown; oauth?: unknown };
    return !(typeof e.revokedAt === "string" && e.revokedAt) && Boolean(e.oauth);
  } catch {
    return false;
  }
}

/**
 * OAU-08 — resolve a bearer token to an OAuth device id, or null.
 * Checks expiry, the refresh family and the device entry (revocation).
 */
export async function resolveAccessToken(token: string): Promise<string | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const raw = await getKVStore().get(`oauth:at:${sha256(token)}`);
  if (!raw) return null;
  let rec: TokenRecord;
  try {
    rec = JSON.parse(raw) as TokenRecord;
  } catch {
    return null;
  }
  if (rec.exp < Math.floor(Date.now() / 1000)) return null;
  if (await familyRevoked(rec.familyId)) return null;
  if (!(await deviceActive(rec.deviceId))) return null;
  return rec.deviceId;
}

// ── metadata documents ───────────────────────────────────────────────

/** OAU-01 — RFC 9728 protected resource metadata. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Kebab House",
  };
}

/** OAU-02 — RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** OAU-03 — the WWW-Authenticate challenge on a 401 from /api/mcp. */
export function wwwAuthenticate(origin: string): string {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${OAUTH_SCOPE}"`;
}
