import type { ConnectorManifest, ConnectorState, ToolDefinition } from "./types";
import { getEnabledPacksOverride } from "./config";
import { on } from "./events";
import { hydrateCredentialsFromKV } from "./credential-store";
import { getConfig } from "./config-facade";

// ── PERF-01: lazy connector loaders ──────────────────────────────────
//
// Prior to Phase 43 the 14 connector manifests imported statically at the
// top of this module. Every lambda cold-start paid the full cost of
// loading all 14 — even deploys that only had GOOGLE_* env vars set still
// pulled in Stagehand, Browserbase SDK, Composio, google-auth-library,
// pino, and all their transitive deps into the transport lambda's trace
// (~130 traced entries = 33% of the pre-PERF-01 route.js.nft.json).
//
// The lazy loader table below keeps a tiny static metadata surface
// (id, label, description, requiredEnvVars, toolCount) that downstream
// UI + gate logic need BEFORE the manifest loads, and defers the actual
// `import()` until the entry passes the gate. In-flight Map dedupes
// concurrent resolves so each manifest loads at most once per process.
//
// Two connectors (webhook, paywall) have custom `isActive(env)` predicates
// on their manifest that require the manifest object to evaluate. For
// those we still load the manifest — the cost is 2/14 connectors plus
// their (small) lib deps, documented as an acceptable overshoot.
//
// Callers:
// - `resolveRegistryAsync()` — async entry point. Call from any async frame
//   (RSC, route handler) before hot-path sync reads.
// - `resolveRegistry()` — sync cache read. Throws if cold. Call from
//   request-hot paths that already have a warm cache upstream.
// - `getEnabledPacks()` — filter the sync read to enabled connectors only.
// - `getEnabledPacksLazy()` — async filter; use from warm-cold boundaries.

interface ConnectorLoaderEntry {
  id: string;
  label: string;
  description: string;
  requiredEnvVars: string[];
  /**
   * Tool count — static mirror of `manifest.tools.length`. Kept in sync
   * via a contract test (`tests/contract/registry-metadata-consistency.test.ts`)
   * that loads every manifest and asserts equality.
   */
  toolCount: number;
  /**
   * Optional flag: connector has a custom `isActive(env)` predicate on its
   * manifest. When true, we must load the manifest even on a "missing env
   * vars" gate to run the predicate. Defaults to false.
   */
  hasCustomActive?: boolean;
  /**
   * `core: true` connectors (skills, admin) are hidden from the Connectors
   * tab but always load. Mirrored here for the stub manifest.
   */
  core?: boolean;
  loader: () => Promise<ConnectorManifest>;
}

export const ALL_CONNECTOR_LOADERS: ConnectorLoaderEntry[] = [
  {
    id: "google",
    label: "Google Workspace",
    description: "Gmail, Calendar, Drive, Docs, and Sheets via a single OAuth2 refresh token.",
    requiredEnvVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
    toolCount: 18,
    loader: () => import("@/connectors/google/manifest").then((m) => m.googleConnector),
  },
  {
    id: "vault",
    label: "Obsidian Vault",
    description: "Read, search, and write markdown notes in a GitHub-hosted Obsidian vault.",
    requiredEnvVars: ["GITHUB_PAT", "GITHUB_REPO"],
    toolCount: 14,
    loader: () => import("@/connectors/vault/manifest").then((m) => m.vaultConnector),
  },
  {
    id: "browser",
    label: "Browser Automation",
    description: "Headless browser navigation + extraction via Browserbase + Stagehand.",
    requiredEnvVars: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "OPENROUTER_API_KEY"],
    toolCount: 4,
    loader: () => import("@/connectors/browser/manifest").then((m) => m.browserConnector),
  },
  {
    id: "slack",
    label: "Slack",
    description: "Search messages, read channels, and send DMs via a Bot User OAuth token.",
    requiredEnvVars: ["SLACK_BOT_TOKEN"],
    toolCount: 6,
    loader: () => import("@/connectors/slack/manifest").then((m) => m.slackConnector),
  },
  {
    id: "notion",
    label: "Notion",
    description: "Search pages, read content, and create/update Notion databases.",
    requiredEnvVars: ["NOTION_API_KEY"],
    toolCount: 5,
    loader: () => import("@/connectors/notion/manifest").then((m) => m.notionConnector),
  },
  {
    id: "composio",
    label: "Composio",
    description: "Bridge to 200+ SaaS integrations via a single Composio API key.",
    requiredEnvVars: ["COMPOSIO_API_KEY"],
    toolCount: 2,
    loader: () => import("@/connectors/composio/manifest").then((m) => m.composioConnector),
  },
  {
    id: "skills",
    label: "Skills",
    description: "User-defined dynamic tools authored in the /config dashboard.",
    requiredEnvVars: [],
    toolCount: 0, // dynamic — actual count loaded with manifest; stub shows 0.
    core: true,
    loader: () => import("@/connectors/skills/manifest").then((m) => m.skillsConnector),
  },
  {
    id: "paywall",
    label: "Paywall Readers",
    description:
      "Read paywalled articles (Medium, Substack) by reusing your logged-in browser session cookies.",
    requiredEnvVars: [],
    // read_paywalled is always present; read_paywalled_hard is conditional
    // on the Browser connector being configured. Static count reflects the
    // always-present surface; the runtime manifest adds the hard tool if
    // the browser configuration is present.
    toolCount: 1,
    hasCustomActive: true,
    loader: () => import("@/connectors/paywall/manifest").then((m) => m.paywallConnector),
  },
  {
    id: "apify",
    label: "Apify",
    description:
      "Run Apify actors for LinkedIn scraping, Twitter, and other structured-data extraction.",
    requiredEnvVars: ["APIFY_TOKEN"],
    toolCount: 8,
    loader: () => import("@/connectors/apify/manifest").then((m) => m.apifyConnector),
  },
  {
    id: "github",
    label: "GitHub Issues",
    description: "List, create, comment on, and close GitHub issues across repos.",
    requiredEnvVars: ["GITHUB_TOKEN"],
    toolCount: 6,
    loader: () => import("@/connectors/github/manifest").then((m) => m.githubConnector),
  },
  {
    id: "linear",
    label: "Linear",
    description: "Create and manage Linear issues via a personal API key.",
    requiredEnvVars: ["LINEAR_API_KEY"],
    toolCount: 6,
    loader: () => import("@/connectors/linear/manifest").then((m) => m.linearConnector),
  },
  {
    id: "airtable",
    label: "Airtable",
    description: "Read and write records in Airtable bases via a personal access token.",
    requiredEnvVars: ["AIRTABLE_API_KEY"],
    toolCount: 7,
    loader: () => import("@/connectors/airtable/manifest").then((m) => m.airtableConnector),
  },
  {
    id: "webhook",
    label: "Webhook Receiver",
    description: "Receive and store external webhook payloads for retrieval via MCP tools",
    requiredEnvVars: [],
    toolCount: 3,
    hasCustomActive: true,
    loader: () => import("@/connectors/webhook/manifest").then((m) => m.webhookConnector),
  },
  {
    id: "admin",
    label: "Admin",
    description: "Framework-level admin tools (health check, tool toggle, etc.)",
    requiredEnvVars: [],
    toolCount: 5,
    core: true,
    loader: () => import("@/connectors/admin/manifest").then((m) => m.adminConnector),
  },
];

// ── Loader spy hook for tests ────────────────────────────────────────
//
// Tests wrap loader invocation via `__setLoaderSpyForTests(cb)` to assert
// that disabled connectors never load. Production code never sets a spy;
// the hook is a no-op otherwise.

type LoaderSpy = (id: string) => void;
let loaderSpy: LoaderSpy | null = null;
export function __setLoaderSpyForTests(cb: LoaderSpy): void {
  loaderSpy = cb;
}
export function __clearLoaderSpyForTests(): void {
  loaderSpy = null;
}

// ── registerPrompts validation ───────────────────────────────────────
//
// Pre-PERF-01 the validation ran once at module-scope across all 14
// statically-imported manifests. Now manifests load lazily, so the
// validator runs immediately after each `await loader()`.

function validateRegisterPrompts(manifest: ConnectorManifest): void {
  if (
    "registerPrompts" in manifest &&
    manifest.registerPrompts !== undefined &&
    typeof manifest.registerPrompts !== "function"
  ) {
    throw new Error(
      `[Kebab MCP] Connector "${manifest.id}" sets registerPrompts to a ` +
        `${typeof manifest.registerPrompts} — it must be a function or omitted.`
    );
  }
}

/**
 * Test-only export — lets the registry-lazy test assert validation
 * behavior without constructing a fake loader.
 */
export function __validateRegisterPromptsForTests(m: ConnectorManifest): void {
  validateRegisterPrompts(m);
}

// ── Cache + in-flight dedup ──────────────────────────────────────────

let cachedRegistry: ConnectorState[] | null = null;
const inFlight = new Map<string, Promise<ConnectorManifest>>();

function invalidateRegistryCache(): void {
  cachedRegistry = null;
  inFlight.clear();
}

// Subscribe once per process — survives HMR via globalThis Symbol.
const REGISTRY_SUBSCRIBED = Symbol.for("mymcp.registry.subscribed");
type GlobalWithFlag = typeof globalThis & { [REGISTRY_SUBSCRIBED]?: boolean };
function subscribeOnce(): void {
  const g = globalThis as GlobalWithFlag;
  if (g[REGISTRY_SUBSCRIBED]) return;
  g[REGISTRY_SUBSCRIBED] = true;
  on("env.changed", invalidateRegistryCache);
  on("connector.toggled", invalidateRegistryCache);
}
subscribeOnce();

/**
 * Test-only escape hatch for resetting the registry cache between
 * tests that mutate process.env directly. Production code should rely
 * on emit("env.changed").
 */
export function __resetRegistryCacheForTests(): void {
  cachedRegistry = null;
  inFlight.clear();
}

// ── Gate predicate ───────────────────────────────────────────────────
//
// Decides whether a loader entry should be loaded. Runs on the static
// metadata alone — no manifest import needed UNLESS `hasCustomActive`
// is true (webhook, paywall).

type GateResult =
  | { kind: "accept" }
  | { kind: "reject"; reason: string }
  | { kind: "needs-custom-active" };

function gateConnector(
  entry: ConnectorLoaderEntry,
  enabledOverride: Set<string> | undefined,
  env: NodeJS.ProcessEnv
): GateResult {
  // Check explicit enable list (if set)
  if (enabledOverride && !enabledOverride.has(entry.id)) {
    return { kind: "reject", reason: "not listed in KEBAB_ENABLED_PACKS" };
  }
  // Check force-disable
  const disableKey = `MYMCP_DISABLE_${entry.id.toUpperCase()}`;
  if (env[disableKey] === "true") {
    return { kind: "reject", reason: `disabled via ${disableKey}` };
  }
  // Connectors with custom isActive: defer to manifest load.
  if (entry.hasCustomActive) {
    return { kind: "needs-custom-active" };
  }
  // Default: check required env vars (AND semantics).
  const missing = entry.requiredEnvVars.filter((v) => !env[v]);
  if (missing.length > 0) {
    return { kind: "reject", reason: `missing env: ${missing.join(", ")}` };
  }
  return { kind: "accept" };
}

// ── Stub manifest for disabled connectors ────────────────────────────
//
// Downstream UI (`app/config/tabs/connectors.tsx`) reads `manifest.label`,
// `manifest.description`, `manifest.tools` (for the disabled-card tool
// count teaser). We synthesize a minimal manifest from the static entry
// metadata — the tools array is empty (manifest hasn't been loaded);
// `toolCount` is exposed separately via the connector summary.

function synthesizeStubManifest(entry: ConnectorLoaderEntry): ConnectorManifest {
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description,
    requiredEnvVars: entry.requiredEnvVars,
    tools: [] as ToolDefinition[],
    core: entry.core,
  };
}

// ── Public exports ───────────────────────────────────────────────────

/**
 * Resolve the registry asynchronously. This is the primary entry point
 * for lazy-loading deploys:
 *
 * 1. Hydrates KV-backed credentials into process.env.
 * 2. Gates each connector against its env vars + toggles.
 * 3. Imports only the manifests that pass the gate (in parallel, deduped).
 * 4. Validates `registerPrompts` on each loaded manifest.
 * 5. Builds `ConnectorState[]` with full manifests for enabled + stub
 *    manifests for disabled.
 * 6. Caches the result; subsequent calls hit the cache until the event
 *    bus invalidates it (or a test explicitly resets).
 *
 * Concurrent invocations dedupe via an in-flight `Map` — each manifest
 * loads at most once per cache lifetime, regardless of how many
 * callers await this function before the first resolve completes.
 */
export async function resolveRegistryAsync(): Promise<ConnectorState[]> {
  await hydrateCredentialsFromKV();

  // Hydration may have populated new env vars; invalidate so we re-gate.
  // (The prior implementation did the same; we preserve the semantics
  // even though re-gating after hydrate is the common case.)
  cachedRegistry = null;

  const enabledOverride = getEnabledPacksOverride();
  const results: ConnectorState[] = new Array(ALL_CONNECTOR_LOADERS.length);
  const loadPromises: Promise<void>[] = [];

  for (let i = 0; i < ALL_CONNECTOR_LOADERS.length; i++) {
    const entry = ALL_CONNECTOR_LOADERS[i];
    if (!entry) continue;
    const gate = gateConnector(entry, enabledOverride, process.env);

    if (gate.kind === "reject") {
      results[i] = {
        manifest: synthesizeStubManifest(entry),
        enabled: false,
        reason: gate.reason,
      };
      continue;
    }

    // accept | needs-custom-active — load the manifest (deduped).
    let p = inFlight.get(entry.id);
    if (!p) {
      // Invoke spy BEFORE the loader so tests can count actual loads
      // including the custom-active cases.
      if (loaderSpy) loaderSpy(entry.id);
      p = entry.loader().then((m) => {
        validateRegisterPrompts(m);
        return m;
      });
      inFlight.set(entry.id, p);
    }

    loadPromises.push(
      p.then((manifest) => {
        if (gate.kind === "needs-custom-active") {
          // Custom predicate lives on the manifest; evaluate now.
          if (manifest.isActive) {
            const r = manifest.isActive(process.env);
            if (!r.active) {
              results[i] = {
                manifest,
                enabled: false,
                reason: r.reason || "inactive",
              };
              return;
            }
          }
          // Else: custom-active flag was set but manifest has no predicate;
          // fall back to the default missing-env check.
          const missing = entry.requiredEnvVars.filter((v) => !getConfig(v));
          if (missing.length > 0) {
            results[i] = {
              manifest,
              enabled: false,
              reason: `missing env: ${missing.join(", ")}`,
            };
            return;
          }
        }
        results[i] = { manifest, enabled: true, reason: "active" };
      })
    );
  }

  await Promise.all(loadPromises);
  cachedRegistry = results;
  return results;
}

/**
 * Resolve the registry synchronously from the cache. This ONLY works
 * AFTER `resolveRegistryAsync()` has populated the cache. Callers in
 * hot request paths (transport handler, RSC page renders) where an
 * upstream entry-point has already awaited the async resolve can use
 * this for a zero-cost cache read.
 *
 * Throws a clear error when the cache is cold — lazy loaders cannot
 * synthesize a manifest without an async frame. Callers that need a
 * cold-path read should migrate to `getEnabledPacksLazy()` or await
 * `resolveRegistryAsync()` directly.
 *
 * Post-PERF-01 sync callers audited:
 * - app/api/[transport]/route.ts — migrated to async upstream of buildHandler.
 * - app/config/page.tsx — migrated to await resolveRegistryAsync().
 * - app/api/admin/status/route.ts — migrated to await.
 * - app/api/health/route.ts — migrated to await.
 * - app/api/admin/call/route.ts — awaits hydrateCredentials already, migrated.
 * - app/api/config/*.ts (sandbox, skills, tool-schema) — migrated.
 * - app/api/admin/verify/route.ts — migrated.
 * - app/api/setup/test/route.ts — migrated.
 * - app/api/cron/health/route.ts — migrated.
 * - scripts/registry-test.ts — script; uses awaited resolveRegistryAsync.
 * - src/core/registry-transitions.test.ts — test; uses awaited resolve.
 */
export function resolveRegistry(): ConnectorState[] {
  if (cachedRegistry === null) {
    throw new Error(
      "resolveRegistry() called before any resolveRegistryAsync() warmed the cache. " +
        "Lazy loaders need async context — call `await resolveRegistryAsync()` first, " +
        "or use `await getEnabledPacksLazy()` if you need the enabled subset."
    );
  }
  return cachedRegistry;
}

/** Get only the enabled packs (sync; requires warm cache). */
export function getEnabledPacks(): ConnectorState[] {
  return resolveRegistry().filter((p) => p.enabled);
}

/** Async variant — safe to call from cold paths. */
export async function getEnabledPacksLazy(): Promise<ConnectorState[]> {
  const state = await resolveRegistryAsync();
  return state.filter((p) => p.enabled);
}

/**
 * Force-load a specific connector's full manifest regardless of gate state.
 *
 * Use from routes that need to call manifest methods (`testConnection`,
 * `isActive`, etc.) on a connector that may be disabled by missing env vars.
 * Canonical use-case: `POST /api/setup/test` — the wizard passes draft
 * credentials to the connector's `testConnection` BEFORE the env vars are
 * persisted, so the gated-resolve path would return a stub manifest.
 *
 * The in-flight map dedupes concurrent force-loads against concurrent
 * `resolveRegistryAsync()` invocations — each manifest's `import()` runs at
 * most once per cache lifetime.
 *
 * Returns `null` if the id does not match any known loader entry.
 */
export async function loadConnectorManifest(id: string): Promise<ConnectorManifest | null> {
  const entry = ALL_CONNECTOR_LOADERS.find((e) => e.id === id);
  if (!entry) return null;
  let p = inFlight.get(entry.id);
  if (!p) {
    if (loaderSpy) loaderSpy(entry.id);
    p = entry.loader().then((m) => {
      validateRegisterPrompts(m);
      return m;
    });
    inFlight.set(entry.id, p);
  }
  return p;
}

/**
 * Log registry state to console.
 *
 * Async because it awaits `resolveRegistryAsync` — transport route.ts
 * module-load calls it inside a fire-and-forget wrapper so startup log
 * ordering is not a hot-path constraint.
 */
export async function logRegistryState(): Promise<void> {
  const packs = await resolveRegistryAsync();
  const enabled = packs.filter((p) => p.enabled);
  const disabled = packs.filter((p) => !p.enabled);

  console.log(`[Kebab MCP] Registry: ${enabled.length}/${packs.length} packs active`);
  for (const p of enabled) {
    console.log(`[Kebab MCP]   ✓ ${p.manifest.label} (${p.manifest.tools.length} tools)`);
  }
  for (const p of disabled) {
    console.log(`[Kebab MCP]   ✗ ${p.manifest.label} — ${p.reason}`);
  }
}
