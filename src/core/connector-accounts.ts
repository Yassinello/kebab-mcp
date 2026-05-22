/**
 * connector-accounts.ts — multi-account credential store + resolver.
 *
 * Phase 73 (v0.18, MACS-01..06). Each connector can hold N named
 * accounts, each carrying its own token SET (Slack: bot + optional user
 * token; Notion: a single api key). This sits ALONGSIDE the legacy flat
 * `cred:<KEY>` store (credential-store.ts) — it does NOT replace it. The
 * flat store still backs `getCredential()` and remains the source of
 * truth for single-token deployments.
 *
 * Storage shape (all keys tenant-scoped via `getContextKVStore()` — we
 * do NOT prefix again; the TenantKVStore wrapper handles `tenant:<id>:`):
 *
 *   cred:acct:<connectorId>:__index__  → JSON
 *       { accounts: Array<{ slug, name }>, default?: string }
 *   cred:acct:<connectorId>:<slug>     → JSON AccountTokenSet
 *       (e.g. { SLACK_BOT_TOKEN, SLACK_USER_TOKEN? })
 *
 * SEC-02 / MACS-05: every read/write goes through `getContextKVStore()`
 * so a write under tenant A is invisible to tenant B's request context.
 * This module NEVER touches `process.env` — token reads for the
 * legacy-fallback path go through `getCredential()` (request-context
 * aware), exactly like the Unipile resolver reads `getConfig()`.
 *
 * MACS-02 (backward-compat): when no index exists for a connector, we
 * synthesize ONE implicit account `{ slug: "default", name: "default" }`
 * from the connector's legacy flat credential keys (read via
 * `getCredential`). This makes every existing single-token deployment
 * work with zero migration. The legacy keys per connector live in the
 * `ACCOUNT_DESCRIPTORS` registry below (FUT-01: add Google/GitHub here).
 *
 * MACS-03 (resolver): `resolveConnectorAccount()` mirrors the Unipile
 * phase-72 resolver SHAPE exactly (see
 * `src/connectors/unipile/lib/account.ts`):
 *   1. explicit `args.account` → match by slug OR name; found → silent,
 *      MISS → error_account_required (an explicit miss is an error, NOT
 *      a silent fall-through).
 *   2. else load accounts. 0 → error_no_account.
 *   3. validated pinned default: set AND still present → use it.
 *   4. exactly 1 → silent.
 *   5. ≥2 and nothing usable → error_account_required + available names.
 */

import { getContextKVStore, getCredential } from "./request-context";

/** A token SET for one account, keyed by env var name. */
export type AccountTokenSet = Record<string, string>;

/** One named account for a connector. */
export interface ConnectorAccount {
  slug: string;
  name: string;
  tokens: AccountTokenSet;
}

/**
 * Discriminated union mirroring the Unipile resolver shape.
 * `available_accounts` carries display NAMES (not slugs) — same as the
 * Unipile resolver returns ids the caller can re-pass.
 */
export type AccountResolution =
  | { account: ConnectorAccount }
  | { error: "error_no_account" }
  | { error: "error_account_required"; available_accounts: string[] };

/** Persisted index entry — minimal metadata, tokens live per-account. */
interface IndexEntry {
  slug: string;
  name: string;
}

interface AccountIndex {
  accounts: IndexEntry[];
  default?: string;
}

// ── Per-connector account descriptor (FUT-01) ───────────────────────
//
// Maps a connectorId to the legacy flat credential keys MACS-02 reads
// to synthesize the implicit "default" account. `primaryKey` is the key
// that MUST be present for a legacy account to exist at all (the others
// are optional extras, e.g. Slack's user token).
//
// FUT-01: extend the multi-account store to other single-token
// connectors (Google Workspace, GitHub PAT) by adding entries here —
// no branching logic elsewhere needs to change.

interface AccountDescriptor {
  /** Legacy flat `cred:<KEY>` env names that form a single token set. */
  legacyKeys: string[];
  /** The key that must be present for a legacy account to exist. */
  primaryKey: string;
}

const ACCOUNT_DESCRIPTORS: Record<string, AccountDescriptor> = {
  slack: {
    legacyKeys: ["SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"],
    primaryKey: "SLACK_BOT_TOKEN",
  },
  notion: {
    legacyKeys: ["NOTION_API_KEY"],
    primaryKey: "NOTION_API_KEY",
  },
};

const KEY_PREFIX = "cred:acct:";

function indexKey(connectorId: string): string {
  return `${KEY_PREFIX}${connectorId}:__index__`;
}

function accountKey(connectorId: string, slug: string): string {
  return `${KEY_PREFIX}${connectorId}:${slug}`;
}

/**
 * Lowercase, kebab-case a display name into a stable slug. Strips
 * accents and non-alphanumerics, collapses runs into single hyphens,
 * trims leading/trailing hyphens. Falls back to "account" if the name
 * has no usable characters (e.g. emoji-only team names).
 */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "account";
}

/**
 * Slugify `name`, deduping against `taken` by appending -2, -3, … so a
 * second "Acme Corp" becomes "acme-corp-2".
 */
function slugifyUnique(name: string, taken: Set<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

async function readIndex(connectorId: string): Promise<AccountIndex | null> {
  const kv = getContextKVStore();
  const raw = await kv.get(indexKey(connectorId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AccountIndex>;
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    // exactOptionalPropertyTypes: only attach `default` when present.
    return typeof parsed.default === "string"
      ? { accounts, default: parsed.default }
      : { accounts };
  } catch {
    // A corrupt index must not wedge the connector — treat as absent so
    // the legacy-key fallback (MACS-02) still surfaces a usable account.
    return null;
  }
}

async function writeIndex(connectorId: string, index: AccountIndex): Promise<void> {
  const kv = getContextKVStore();
  await kv.set(indexKey(connectorId), JSON.stringify(index));
}

async function readTokens(connectorId: string, slug: string): Promise<AccountTokenSet | null> {
  const kv = getContextKVStore();
  const raw = await kv.get(accountKey(connectorId, slug));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AccountTokenSet;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * MACS-02: synthesize the implicit "default" account from the
 * connector's legacy flat credential keys. Returns null when the
 * connector has no descriptor or its primary key is absent — i.e. there
 * is genuinely no legacy account to surface.
 */
function legacyDefaultAccount(connectorId: string): ConnectorAccount | null {
  const descriptor = ACCOUNT_DESCRIPTORS[connectorId];
  if (!descriptor) return null;

  const primary = getCredential(descriptor.primaryKey)?.trim();
  if (!primary) return null;

  const tokens: AccountTokenSet = {};
  for (const key of descriptor.legacyKeys) {
    const value = getCredential(key)?.trim();
    if (value) tokens[key] = value;
  }
  // primary is guaranteed present (checked above), but keep the loop the
  // single source so optional extras (SLACK_USER_TOKEN) get picked up.
  return { slug: "default", name: "default", tokens };
}

/**
 * List all accounts for a connector.
 *
 * MACS-02: when no index exists (or it lists no accounts), fall back to
 * the connector's legacy flat keys and synthesize a single "default"
 * account. Returns `[]` only when there is neither an index NOR a legacy
 * token — i.e. the connector is genuinely unconfigured.
 */
export async function listAccounts(connectorId: string): Promise<ConnectorAccount[]> {
  const index = await readIndex(connectorId);

  if (!index || index.accounts.length === 0) {
    const legacy = legacyDefaultAccount(connectorId);
    return legacy ? [legacy] : [];
  }

  const accounts: ConnectorAccount[] = [];
  for (const entry of index.accounts) {
    const tokens = await readTokens(connectorId, entry.slug);
    // A dangling index entry (tokens deleted out-of-band) is skipped
    // rather than surfaced as an empty-token account — the resolver
    // would otherwise route to a credential-less account.
    if (!tokens) continue;
    accounts.push({ slug: entry.slug, name: entry.name, tokens });
  }
  return accounts;
}

/**
 * Persist a named account. Slugifies `name` (deduped against the
 * existing index), writes the per-account token key, and upserts the
 * index entry. Returns the stored account (with its resolved slug).
 *
 * If an existing account already carries the same slug (re-save under
 * the same display name), its tokens are overwritten in place and the
 * index entry's name is refreshed — no duplicate is created.
 */
export async function saveAccount(
  connectorId: string,
  name: string,
  tokens: AccountTokenSet
): Promise<ConnectorAccount> {
  const index = (await readIndex(connectorId)) ?? { accounts: [] };

  // Re-save under an identical display name → reuse the existing slug.
  const existing = index.accounts.find((a) => a.name === name);
  const slug = existing
    ? existing.slug
    : slugifyUnique(name, new Set(index.accounts.map((a) => a.slug)));

  const kv = getContextKVStore();
  await kv.set(accountKey(connectorId, slug), JSON.stringify(tokens));

  if (existing) {
    existing.name = name; // name is unchanged here, but keep upsert explicit
  } else {
    index.accounts.push({ slug, name });
  }
  await writeIndex(connectorId, index);

  return { slug, name, tokens };
}

/**
 * Remove an account: delete its per-account token key, drop its index
 * entry, and clear the default if it pointed at the removed slug.
 */
export async function removeAccount(connectorId: string, slug: string): Promise<void> {
  const kv = getContextKVStore();
  await kv.delete(accountKey(connectorId, slug));

  const index = await readIndex(connectorId);
  if (!index) return;

  const accounts = index.accounts.filter((a) => a.slug !== slug);
  const next: AccountIndex =
    index.default && index.default !== slug ? { accounts, default: index.default } : { accounts };
  await writeIndex(connectorId, next);
}

/**
 * Pin the default account for a connector. Writes the slug into the
 * index `default` field. (Validation that the slug exists is the
 * resolver's job — a stale pin falls through to the count rules.)
 */
export async function setDefaultAccount(connectorId: string, slug: string): Promise<void> {
  const index = (await readIndex(connectorId)) ?? { accounts: [] };
  await writeIndex(connectorId, { accounts: index.accounts, default: slug });
}

/** Read the pinned default slug for a connector, if any. */
export async function getDefaultAccount(connectorId: string): Promise<string | undefined> {
  const index = await readIndex(connectorId);
  return index?.default;
}

/**
 * Resolve the effective account for a connector.
 *
 * Precedence (mirrors Unipile `account.ts` D-20 + D-72 SHAPE):
 *   1. explicit `args.account` → match by slug OR name; found → silent,
 *      MISS → error_account_required (explicit miss is an error).
 *   2. else load accounts. 0 → error_no_account.
 *   3. validated pinned default: set AND still present → use it.
 *   4. exactly 1 → silent.
 *   5. ≥2 and nothing usable → error_account_required + available names.
 *
 * A stale pin (default points at a removed account) is NOT honored — it
 * falls through to the count-based rules rather than mis-routing
 * (MACS-04), exactly like Unipile's validated pinned default.
 */
export async function resolveConnectorAccount(
  connectorId: string,
  args: { account?: string }
): Promise<AccountResolution> {
  const accounts = await listAccounts(connectorId);

  // Step 1: explicit account selector. Match by slug OR display name.
  const explicit = args.account?.trim();
  if (explicit) {
    const match = accounts.find((a) => a.slug === explicit || a.name === explicit);
    if (match) return { account: match };
    // Explicit miss is an error — do NOT silently fall through.
    return {
      error: "error_account_required",
      available_accounts: accounts.map((a) => a.name),
    };
  }

  // Step 2: zero accounts.
  if (accounts.length === 0) return { error: "error_no_account" };

  // Step 3: validated pinned default.
  const pinned = await getDefaultAccount(connectorId);
  if (pinned) {
    const match = accounts.find((a) => a.slug === pinned);
    if (match) return { account: match };
    // Stale pin (account removed) → fall through to count-based rules.
  }

  // Step 4: exactly one → silent.
  if (accounts.length === 1) return { account: accounts[0]! };

  // Step 5: ≥2 and nothing usable → safety net listing display names.
  return {
    error: "error_account_required",
    available_accounts: accounts.map((a) => a.name),
  };
}
