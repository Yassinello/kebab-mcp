import { getContextKVStore } from "@/core/request-context";
import {
  customToolSchema,
  customToolWriteSchema,
  type CustomTool,
  type CustomToolWriteInput,
} from "./types";
import { validateTemplate } from "./expression";
import { resolveRegistryAsync, ALL_CONNECTOR_LOADERS } from "@/core/registry";
import { CALLABLE_FROM_CUSTOM_TOOLS } from "./runner";
import { on } from "@/core/events";

/**
 * Custom Tools store.
 *
 * Storage model: a single JSON array under the `custom-tools:all` KV
 * key. Mirrors the API Tools / Skills approach — small enough that
 * per-tool keys would be over-engineered, large enough that we serialize
 * writes through a per-process queue to avoid lost-update races.
 *
 * The KV layer is the same `getContextKVStore()` used by every other
 * connector — Upstash on Vercel, filesystem locally, tenant-scoped on
 * multi-tenant deploys.
 *
 * ── HI-04 — Concurrency limitation (acknowledged) ─────────────────────
 *
 * The `writeQueue` below is process-local. On Vercel with multiple warm
 * lambdas, two concurrent writes from different lambda instances can
 * both pass the duplicate-id check (read-modify-write is non-atomic on
 * Upstash) and the second write silently overwrites the first.
 *
 * Probability is low for this feature — Custom Tool writes are admin
 * actions performed from the dashboard, so concurrent writes mean an
 * operator was clicking Save twice at the same time across two browser
 * tabs against two warm lambdas. Real-world traffic does not justify
 * the complexity of a versioned compare-and-swap (separate
 * `custom-tools:version` key + atomic check + 409 conflict UX in the
 * drawer).
 *
 * TODO: replace with compare-and-swap when multi-process traffic
 * justifies it. The simplest path is a `custom-tools:rev` key bumped on
 * every write; the writer reads the rev before modifying and aborts if
 * it changed by the time it goes to write back. Sketch:
 *   1. read `:rev`  → r0
 *   2. read `:all`, compute new array
 *   3. write `:rev` → r0+1 via setIfNotExists(:rev, r0+1) — only the
 *      first writer to bump wins; the loser refetches and retries (or
 *      surfaces a 409 to the dashboard).
 */

const KV_KEY = "custom-tools:all";

// ── Write queue ───────────────────────────────────────────────────────
//
// Process-local serialization — mitigates intra-lambda races (two
// requests on the same warm lambda) but does NOT cover inter-lambda
// races (see HI-04 in the file header).

let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(() => fn());
  writeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// ── Raw I/O ───────────────────────────────────────────────────────────

async function readRaw(): Promise<CustomTool[]> {
  const kv = getContextKVStore();
  const raw = await kv.get(KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: CustomTool[] = [];
    for (const row of parsed) {
      const res = customToolSchema.safeParse(row);
      if (res.success) out.push(res.data);
    }
    return out;
  } catch {
    return [];
  }
}

async function writeRaw(rows: CustomTool[]): Promise<void> {
  const kv = getContextKVStore();
  await kv.set(KV_KEY, JSON.stringify(rows));
  _syncCache = rows;
}

// ── Validation helper ─────────────────────────────────────────────────

/**
 * Validate every Mustache template in the tool early — both transform
 * templates and templated string args inside `tool` steps. The author
 * sees a precise error at write time rather than at first invocation.
 */
function validateAllTemplates(tool: CustomToolWriteInput): void {
  for (let i = 0; i < tool.steps.length; i++) {
    const step = tool.steps[i]!;
    if (step.kind === "transform") {
      try {
        validateTemplate(step.template);
      } catch (err) {
        throw new Error(`step[${i}] template invalid: ${(err as Error).message}`, {
          cause: err,
        });
      }
    } else {
      // Walk args, validate every string leaf as a template.
      walkStrings(step.args, (s, path) => {
        try {
          validateTemplate(s);
        } catch (err) {
          throw new Error(`step[${i}].args${path} template invalid: ${(err as Error).message}`, {
            cause: err,
          });
        }
      });
    }
  }
}

/**
 * Snapshot of the merged registry as a flat lookup `name → { packId,
 * destructive }`. Used by both write-time validators (HI-02 toolName
 * check + HI-03 destructive aggregation). Walking the registry once and
 * threading the result is cheaper than two passes — `resolveRegistryAsync`
 * itself is cached, but the disabled-connector force-loads inside this
 * function are not.
 */
interface ToolFacts {
  packId: string;
  destructive: boolean;
}

/**
 * Cached snapshot of the merged registry tool surface. The store rebuilds
 * it on first need and on any registry-mutating event (`env.changed`,
 * `connector.toggled`). Without this cache, every Custom Tool write would
 * cold-load 16 connector manifests (paywall, browser, stagehand, …) —
 * 5–15s per write on a cold lambda, which both blows out the request
 * budget AND deadlocks tests that run inside the write queue.
 */
let _knownToolFactsCache: Map<string, ToolFacts> | null = null;

function invalidateKnownToolFactsCache(): void {
  _knownToolFactsCache = null;
}
on("env.changed", invalidateKnownToolFactsCache);
on("connector.toggled", invalidateKnownToolFactsCache);

/** Test-only — drop the cache between scenarios. */
export function _resetKnownToolFactsCacheForTests(): void {
  _knownToolFactsCache = null;
}

async function buildKnownToolFacts(): Promise<Map<string, ToolFacts>> {
  if (_knownToolFactsCache) return _knownToolFactsCache;
  const known = new Map<string, ToolFacts>();
  const states = await resolveRegistryAsync();
  // Force-load disabled manifests in parallel — concurrent loads dedupe
  // through the registry's in-flight map, so this is one round-trip even
  // if a dozen Custom Tool writes hit at once.
  await Promise.all(
    states.map(async (s) => {
      if (s.enabled) {
        for (const t of s.manifest.tools) {
          known.set(t.name, { packId: s.manifest.id, destructive: !!t.destructive });
        }
        return;
      }
      const entry = ALL_CONNECTOR_LOADERS.find((e) => e.id === s.manifest.id);
      if (!entry) return;
      try {
        const loaded = await entry.loader();
        for (const t of loaded.tools) {
          known.set(t.name, { packId: loaded.id, destructive: !!t.destructive });
        }
      } catch {
        // Loader failure is non-fatal — over-allow on validation rather
        // than block writes on an unrelated import error.
      }
    })
  );
  _knownToolFactsCache = known;
  return known;
}

/**
 * HI-02 — Validate every `toolName` referenced by a `tool` step against
 * the live registry AND the CALLABLE_FROM_CUSTOM_TOOLS allowlist. Run at
 * write time so the author sees a precise error on save instead of at
 * the first invocation (which, for a 5-step tool with a typo in step 4,
 * means running 3 unrelated steps before the error surfaces).
 *
 * We enumerate the FULL surface (enabled + disabled connectors) so a
 * Custom Tool that references a Slack tool while Slack is disabled
 * still passes — Slack tools become callable the moment Slack is
 * enabled, and refusing the write would force authors to enable
 * connectors they don't yet need.
 *
 * Errors are thrown as plain `Error` so the route handler maps them to
 * the standard 400 with the toolName in the message.
 */
function validateAllToolNames(
  steps: CustomToolWriteInput["steps"],
  known: Map<string, ToolFacts>
): void {
  const toolStepNames = new Set<string>();
  for (const step of steps) {
    if (step.kind === "tool") toolStepNames.add(step.toolName);
  }
  if (toolStepNames.size === 0) return;

  for (const name of toolStepNames) {
    const facts = known.get(name);
    if (!facts) {
      throw new Error(`tool "${name}" does not exist or is not callable from custom tools`);
    }
    if (!CALLABLE_FROM_CUSTOM_TOOLS.has(facts.packId)) {
      throw new Error(
        `tool "${name}" does not exist or is not callable from custom tools (pack "${facts.packId}" is not in allowlist)`
      );
    }
  }
}

/**
 * HI-03 — Compute whether a Custom Tool's composed surface is destructive.
 * Returns `true` if ANY `tool` step calls a tool whose underlying
 * registry entry has `destructive: true`. Authors who omit `destructive`
 * at the top-level get the safe default — a tool that calls
 * `vault_write` is exposed as destructive even if the JSON spec didn't
 * say so. MCP clients that filter destructive tools (claude.ai, cline)
 * then treat it correctly without operator awareness.
 */
function computeAggregateDestructive(
  steps: CustomToolWriteInput["steps"],
  known: Map<string, ToolFacts>
): boolean {
  for (const step of steps) {
    if (step.kind !== "tool") continue;
    const facts = known.get(step.toolName);
    if (facts?.destructive) return true;
  }
  return false;
}

function walkStrings(v: unknown, visit: (s: string, path: string) => void, path = ""): void {
  if (v === null || v === undefined) return;
  if (typeof v === "string") {
    visit(v, path);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((item, idx) => walkStrings(item, visit, `${path}[${idx}]`));
    return;
  }
  if (typeof v === "object") {
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      walkStrings(child, visit, `${path}.${k}`);
    }
  }
}

// ── Public CRUD ───────────────────────────────────────────────────────

export async function listCustomTools(): Promise<CustomTool[]> {
  return readRaw();
}

export async function getCustomTool(id: string): Promise<CustomTool | null> {
  const all = await readRaw();
  return all.find((t) => t.id === id) ?? null;
}

export function createCustomTool(input: CustomToolWriteInput): Promise<CustomTool> {
  return enqueueWrite(async () => {
    const parsed = customToolWriteSchema.parse(input);
    validateAllTemplates(parsed);
    // Only walk the registry if we actually need it — transform-only
    // Custom Tools require neither toolName validation nor destructive
    // aggregation, and the registry walk is the slow part of a write.
    const needsRegistry = parsed.steps.some((s) => s.kind === "tool");
    const known = needsRegistry ? await buildKnownToolFacts() : new Map<string, ToolFacts>();
    validateAllToolNames(parsed.steps, known);
    const all = await readRaw();
    if (all.some((t) => t.id === parsed.id)) {
      throw new Error(`a Custom Tool with id "${parsed.id}" already exists`);
    }
    const now = new Date().toISOString();
    // HI-03 — force-set destructive when any step calls a destructive
    // step tool, so the exposed MCP tool can never be less destructive
    // than its composed surface (claude.ai, cline et al gate on this).
    const aggDestructive = computeAggregateDestructive(parsed.steps, known);
    const tool: CustomTool = {
      ...parsed,
      destructive: (parsed.destructive ?? false) || aggDestructive,
      inputs: parsed.inputs ?? [],
      createdAt: now,
      updatedAt: now,
    };
    all.push(tool);
    await writeRaw(all);
    return tool;
  });
}

export function updateCustomTool(
  id: string,
  patch: CustomToolWriteInput
): Promise<CustomTool | null> {
  return enqueueWrite(async () => {
    const parsed = customToolWriteSchema.parse(patch);
    validateAllTemplates(parsed);
    // Only walk the registry if we actually need it — transform-only
    // Custom Tools require neither toolName validation nor destructive
    // aggregation, and the registry walk is the slow part of a write.
    const needsRegistry = parsed.steps.some((s) => s.kind === "tool");
    const known = needsRegistry ? await buildKnownToolFacts() : new Map<string, ToolFacts>();
    validateAllToolNames(parsed.steps, known);
    const all = await readRaw();
    const idx = all.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const prev = all[idx]!;
    // Reject id renames via PUT — they would orphan KV references and
    // leak the old tool name into the MCP registry until the next
    // primeCustomToolsCache(). Authors should DELETE + POST instead.
    if (parsed.id !== prev.id) {
      throw new Error(`Custom Tool id is immutable (got "${parsed.id}", existing "${prev.id}")`);
    }
    // HI-03 — same aggregation as create.
    const aggDestructive = computeAggregateDestructive(parsed.steps, known);
    const next: CustomTool = {
      ...prev,
      description: parsed.description,
      destructive: (parsed.destructive ?? false) || aggDestructive,
      inputs: parsed.inputs ?? [],
      steps: parsed.steps,
      updatedAt: new Date().toISOString(),
    };
    all[idx] = next;
    await writeRaw(all);
    return next;
  });
}

export function deleteCustomTool(id: string): Promise<boolean> {
  return enqueueWrite(async () => {
    const all = await readRaw();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length) return false;
    await writeRaw(next);
    return true;
  });
}

// ── Sync cache (for the manifest's synchronous `tools` getter) ────────

let _syncCache: CustomTool[] = [];

/** Return the in-memory snapshot. The manifest reads this on every
 *  access; the registry's `refresh` hook keeps it warm. */
export function listCustomToolsSync(): CustomTool[] {
  return _syncCache;
}

/** Refresh the sync cache from the authoritative store. Idempotent. */
export async function primeCustomToolsCache(): Promise<void> {
  try {
    _syncCache = await readRaw();
  } catch {
    _syncCache = [];
  }
}

/** Test-only — drop the cache so tests don't leak state across files. */
export function _resetCustomToolsCacheForTests(): void {
  _syncCache = [];
}
