import { getContextKVStore } from "@/core/request-context";
import { toMsg } from "@/core/error-utils";
import { TenantCache } from "@/core/tenant-cache";
import { bumpConfigRevision } from "@/core/config-revision";
import {
  customToolSchema,
  customToolWriteSchema,
  type CustomTool,
  type CustomToolVersion,
  type CustomToolWriteInput,
} from "./types";
import { validateTemplate, extractRootVars } from "./expression";
import { resolveRegistryAsync, ALL_CONNECTOR_LOADERS } from "@/core/registry";
import { CALLABLE_FROM_CUSTOM_TOOLS } from "./runner";
import { on } from "@/core/events";
import { estimateToolCost, getMaxCostPerRun, type CostRegistry } from "./cost";

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

// ── Versioning (Phase 6) ──────────────────────────────────────────────
//
// A simple JSON-encoded array under `customtool:versions:<id>`, newest
// first, capped at MAX_VERSIONS entries. We deliberately don't use the
// optional `lpushCapped` interface — it's Upstash-only, and a small
// JSON blob is fine here (10 × tool snapshot ≈ a few KB at worst, well
// under the 100KB Upstash value cap).
const MAX_VERSIONS = 10;
function versionsKey(id: string): string {
  return `customtool:versions:${id}`;
}

async function readVersions(id: string): Promise<CustomToolVersion[]> {
  const kv = getContextKVStore();
  const raw = await kv.get(versionsKey(id));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Each entry must round-trip the CustomTool schema — anything that
    // doesn't (because we evolved the schema since it was saved) is
    // silently dropped rather than blowing up the History panel.
    const out: CustomToolVersion[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const r = row as { tool?: unknown; supersededAt?: unknown; supersededBy?: unknown };
      if (typeof r.supersededAt !== "string") continue;
      const toolRes = customToolSchema.safeParse(r.tool);
      if (!toolRes.success) continue;
      const entry: CustomToolVersion = {
        tool: toolRes.data,
        supersededAt: r.supersededAt,
      };
      if (r.supersededBy && typeof r.supersededBy === "object") {
        const by = r.supersededBy as { tokenIdShort?: unknown };
        if (typeof by.tokenIdShort === "string") {
          entry.supersededBy = { tokenIdShort: by.tokenIdShort };
        }
      }
      out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

async function writeVersions(id: string, versions: CustomToolVersion[]): Promise<void> {
  const kv = getContextKVStore();
  await kv.set(versionsKey(id), JSON.stringify(versions));
}

/**
 * Push a previous-snapshot onto the front of the versions list and trim
 * to MAX_VERSIONS. Best-effort — failures are logged-and-continue rather
 * than blocking the save (versioning is a UX nicety, not a correctness
 * invariant; refusing to save because we couldn't write history would be
 * a worse user outcome).
 */
async function pushVersion(
  prev: CustomTool,
  supersededBy?: { tokenIdShort?: string }
): Promise<void> {
  try {
    const existing = await readVersions(prev.id);
    const entry: CustomToolVersion = {
      tool: prev,
      supersededAt: new Date().toISOString(),
      ...(supersededBy ? { supersededBy } : {}),
    };
    const next = [entry, ...existing].slice(0, MAX_VERSIONS);
    await writeVersions(prev.id, next);
  } catch {
    // Best-effort — see comment above. The save itself already
    // succeeded; we don't roll it back if history persistence fails.
  }
}

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
  // Q-01 (2026-11 audit): a corrupt blob used to read as [] — and the next
  // read-modify-write then persisted [] over the whole collection. Fail
  // loudly instead so nothing is overwritten.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`custom tools store (${KV_KEY}) is not valid JSON — refusing to continue`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`custom tools store (${KV_KEY}) is not an array — refusing to continue`);
  }
  const out: CustomTool[] = [];
  let dropped = 0;
  for (const row of parsed) {
    const res = customToolSchema.safeParse(row);
    if (res.success) out.push(res.data);
    else dropped++;
  }
  if (dropped > 0) {
    console.warn(
      `[Kebab MCP] custom tools: ${dropped} stored row(s) failed validation and were skipped`
    );
  }
  return out;
}

async function writeRaw(rows: CustomTool[]): Promise<void> {
  const kv = getContextKVStore();
  await kv.set(KV_KEY, JSON.stringify(rows));
  _syncCache.set(rows);
  // REL-02: other lambdas re-prime their tool lists.
  await bumpConfigRevision();
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
 * Cross-step variable resolution check (Bonus C).
 *
 * Walk the steps in declaration order, threading a running set of
 * "available" variable names that starts as `inputs[].name` and grows
 * by each step's `saveAs`. For every Mustache reference encountered
 * (in transform `template` strings or templated `tool` step `args`),
 * verify the ROOT identifier is in the available set at THAT point
 * in the sequence.
 *
 * Why root-only: dotted access (`{{user.name}}`) drills into a value
 * the runner produced — we can only meaningfully reason about whether
 * `user` exists, not whether `user.name` is a present field on
 * whatever shape it eventually holds.
 *
 * Throws on the FIRST genuinely-unknown reference with a precise
 * step index + variable name + message. We deliberately stop on the
 * first violation rather than aggregating because:
 *   - a typo in step 1 cascades — `userName` missing in step 1 likely
 *     means it's also missing in step 4, and reporting one error per
 *     step would bury the lede;
 *   - the dashboard surfaces ONE error at a time anyway (the form's
 *     toast/banner), so aggregating just delays useful feedback.
 *
 * False-negative tolerance: an empty-string render is the Mustache
 * default for missing variables, and some authors lean on that for
 * "optional" fields. We do NOT block this — a variable that's
 * defined SOMEWHERE in the visible chain (inputs OR any earlier
 * `saveAs`) passes the check even if its presence is conditional.
 * Only references that are NEVER reachable get rejected.
 */
function validateCrossStepReferences(tool: CustomToolWriteInput): void {
  const availableNames = new Set<string>();
  for (const input of tool.inputs ?? []) {
    availableNames.add(input.name);
  }

  for (let i = 0; i < tool.steps.length; i++) {
    const step = tool.steps[i]!;
    const refs: Set<string> = new Set();

    if (step.kind === "transform") {
      try {
        for (const r of extractRootVars(step.template)) refs.add(r);
      } catch {
        // Already caught by validateAllTemplates — bail out cleanly
        // instead of double-reporting.
        return;
      }
    } else {
      // walk args, collecting every root referenced in any string leaf
      let badParse = false;
      walkStrings(step.args, (s) => {
        if (badParse) return;
        try {
          for (const r of extractRootVars(s)) refs.add(r);
        } catch {
          badParse = true;
        }
      });
      if (badParse) return;
    }

    for (const ref of refs) {
      if (!availableNames.has(ref)) {
        throw new Error(
          `step[${i}]: template references unknown variable '${ref}' ` +
            `(not in inputs and not produced by an earlier step)`
        );
      }
    }

    // After the step, its `saveAs` becomes available to subsequent steps.
    if (step.saveAs) availableNames.add(step.saveAs);
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

/**
 * Phase 2 — Estimate the cost of the inbound tool and reject the
 * write if it exceeds `MAX_COST_PER_RUN`. The error message names
 * the offending number AND the cap so authors immediately know how
 * far they are over budget — and includes a single-sentence
 * remediation hint pointing at the two levers (step count, cheaper
 * tools).
 *
 * Returns the estimate so the caller can stamp it onto the persisted
 * tool without recomputing.
 */
function validateAndComputeCost(
  parsed: CustomToolWriteInput,
  known: Map<string, ToolFacts>,
  others: CustomTool[]
): number {
  const customToolsById = new Map<string, CustomTool | CustomToolWriteInput>();
  for (const t of others) customToolsById.set(t.id, t);
  // The tool currently being written needs to be in the map too —
  // otherwise a self-cycle would resolve to "unknown Custom Tool"
  // (cap charge) instead of the recursion-guard zero. The cycle
  // case itself is caught by the runner; here we just need correct
  // accounting for transitive references in either direction.
  customToolsById.set(parsed.id, parsed);
  const registry: CostRegistry = {
    knownTools: known,
    customToolsById,
  };
  const cost = estimateToolCost(parsed, registry);
  const cap = getMaxCostPerRun();
  if (cost > cap) {
    throw new Error(
      `estimated cost ${cost} exceeds limit ${cap}. Reduce step count or use cheaper tools.`
    );
  }
  return cost;
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

// ── Orphan-test-tool cleanup (Bonus A) ────────────────────────────────

/**
 * Test-tool id prefix used by the dashboard's "Test" button — see
 * `app/config/tabs/custom-tool-edit-page.tsx`. The format is
 *   `t__test_<id-prefix>_<base36 Date.now()>`
 * Tools written under this prefix are scratch artifacts the dashboard
 * creates to invoke the runner before saving the real tool. Under
 * normal operation they are deleted immediately after the test run,
 * but if the browser tab is closed mid-test, the lambda is killed, or
 * a network blip aborts the cleanup leg, they persist in KV and clutter
 * the admin list view + the MCP tool surface (`primeCustomToolsCache`
 * picks them up as if they were real tools).
 */
const TEST_TOOL_PREFIX = "t__test_";
const ORPHAN_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Sweep test-tool orphans older than ORPHAN_MAX_AGE_MS (or with an
 * unparseable timestamp suffix). Runs in fire-and-forget mode from the
 * admin list endpoint so each list view becomes a natural trigger —
 * cheap, no cron required, no separate background worker process.
 *
 * Returns `{ deleted }` so callers/tests can assert the count, but the
 * primary caller (the GET handler) ignores the result.
 *
 * Concurrency: the same `enqueueWrite` queue used by create/update
 * serializes the write — two parallel sweeps cooperate cleanly. The
 * sweep is itself a single read-modify-write under that queue.
 */
export function cleanupOrphanTestTools(): Promise<{ deleted: number }> {
  return enqueueWrite(async () => {
    const all = await readRaw();
    const now = Date.now();
    const survivors: CustomTool[] = [];
    const orphanIds: string[] = [];

    for (const t of all) {
      if (!t.id.startsWith(TEST_TOOL_PREFIX)) {
        survivors.push(t);
        continue;
      }
      // Format: t__test_<idPrefix>_<base36 timestamp>. Take the LAST
      // underscore-segment as the timestamp because the id-prefix can
      // legitimately contain underscores.
      const tail = t.id.slice(TEST_TOOL_PREFIX.length);
      const lastUnderscore = tail.lastIndexOf("_");
      let isOrphan = false;
      if (lastUnderscore < 0) {
        // No timestamp segment at all — definitely an orphan (or a
        // hand-crafted id that happened to share the prefix; either
        // way, prefixed test ids should not be hand-crafted).
        isOrphan = true;
      } else {
        const ts = parseInt(tail.slice(lastUnderscore + 1), 36);
        if (!Number.isFinite(ts) || ts <= 0) {
          isOrphan = true;
        } else if (now - ts > ORPHAN_MAX_AGE_MS) {
          isOrphan = true;
        }
      }

      if (isOrphan) orphanIds.push(t.id);
      else survivors.push(t);
    }

    if (orphanIds.length === 0) return { deleted: 0 };

    await writeRaw(survivors);
    // Drop versions history for swept ids so reuse of the same id
    // doesn't inherit a stale timeline.
    const kv = getContextKVStore();
    await Promise.all(
      orphanIds.map(async (id) => {
        try {
          await kv.delete(versionsKey(id));
        } catch {
          /* best-effort */
        }
      })
    );
    return { deleted: orphanIds.length };
  });
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
    validateCrossStepReferences(parsed);
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
    // Phase 2 — cost validation runs AFTER everything else so the
    // author sees structural errors first (template, toolName) and
    // only hits the cost gate once the spec is otherwise valid.
    const estimatedCost = validateAndComputeCost(parsed, known, all);
    const now = new Date().toISOString();
    // HI-03 — force-set destructive when any step calls a destructive
    // step tool, so the exposed MCP tool can never be less destructive
    // than its composed surface (claude.ai, cline et al gate on this).
    const aggDestructive = computeAggregateDestructive(parsed.steps, known);
    const tool: CustomTool = {
      ...parsed,
      destructive: (parsed.destructive ?? false) || aggDestructive,
      inputs: parsed.inputs ?? [],
      estimatedCost,
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
    validateCrossStepReferences(parsed);
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
    // Phase 2 — cost gate. We exclude the previous version of this
    // tool from `others` so that a self-reference (Custom Tool A
    // calling its own previous incarnation) is correctly handled by
    // the recursion-guard inside `estimateToolCost` rather than
    // double-counting against the stored row.
    const others = all.filter((t) => t.id !== id);
    const estimatedCost = validateAndComputeCost(parsed, known, others);
    // HI-03 — same aggregation as create.
    const aggDestructive = computeAggregateDestructive(parsed.steps, known);
    const next: CustomTool = {
      ...prev,
      description: parsed.description,
      destructive: (parsed.destructive ?? false) || aggDestructive,
      inputs: parsed.inputs ?? [],
      steps: parsed.steps,
      estimatedCost,
      updatedAt: new Date().toISOString(),
    };
    all[idx] = next;
    await writeRaw(all);
    // Phase 6 — snapshot the prior version for the History UI. Done
    // *after* the canonical write succeeds so a versioning blip can't
    // cause the save itself to look failed to the caller.
    await pushVersion(prev);
    return next;
  });
}

export function deleteCustomTool(id: string): Promise<boolean> {
  return enqueueWrite(async () => {
    const all = await readRaw();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length) return false;
    await writeRaw(next);
    // Phase 6 — drop the version history so a future tool reusing the
    // same id can't accidentally inherit the old timeline.
    try {
      const kv = getContextKVStore();
      await kv.delete(versionsKey(id));
    } catch {
      /* best-effort — orphaned history is harmless, just stale */
    }
    return true;
  });
}

// ── Versioning public API (Phase 6) ───────────────────────────────────

/**
 * List all preserved snapshots for a tool, newest-first. Capped at
 * MAX_VERSIONS — older edits have already been dropped on write.
 */
export async function listCustomToolVersions(id: string): Promise<CustomToolVersion[]> {
  return readVersions(id);
}

/**
 * Restore the tool to a prior snapshot. The current state is itself
 * snapshotted onto the front of the versions list (so the rollback
 * itself can be undone), and the restored version goes through the same
 * validation pipeline as a fresh write — toolName, cost, destructive
 * aggregation, templates. Returns null if the tool or version doesn't
 * exist.
 *
 * `versionIndex` is 0-based against `listCustomToolVersions(id)` — 0
 * means "the most recent prior version", which matches the UI ordering.
 */
export function rollbackCustomTool(id: string, versionIndex: number): Promise<CustomTool | null> {
  return enqueueWrite(async () => {
    if (!Number.isFinite(versionIndex) || versionIndex < 0) {
      throw new Error("versionIndex must be a non-negative integer");
    }
    const versions = await readVersions(id);
    const target = versions[versionIndex];
    if (!target) return null;
    const all = await readRaw();
    const idx = all.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const prev = all[idx]!;

    // Re-validate the restored snapshot against the live registry.
    // A tool that was valid 4 edits ago might reference a connector
    // that's since been removed — better to surface a clear error than
    // silently re-publish a broken tool.
    const writeInput: CustomToolWriteInput = {
      id: target.tool.id,
      description: target.tool.description,
      destructive: target.tool.destructive,
      inputs: target.tool.inputs,
      steps: target.tool.steps,
      ...(target.tool.maxStepMs !== undefined ? { maxStepMs: target.tool.maxStepMs } : {}),
      ...(target.tool.maxTotalMs !== undefined ? { maxTotalMs: target.tool.maxTotalMs } : {}),
    };
    const parsed = customToolWriteSchema.parse(writeInput);
    validateAllTemplates(parsed);
    validateCrossStepReferences(parsed);
    const needsRegistry = parsed.steps.some((s) => s.kind === "tool");
    const known = needsRegistry ? await buildKnownToolFacts() : new Map<string, ToolFacts>();
    validateAllToolNames(parsed.steps, known);
    const others = all.filter((t) => t.id !== id);
    const estimatedCost = validateAndComputeCost(parsed, known, others);
    const aggDestructive = computeAggregateDestructive(parsed.steps, known);

    const restored: CustomTool = {
      ...prev,
      description: parsed.description,
      destructive: (parsed.destructive ?? false) || aggDestructive,
      inputs: parsed.inputs ?? [],
      steps: parsed.steps,
      estimatedCost,
      updatedAt: new Date().toISOString(),
    };
    all[idx] = restored;
    await writeRaw(all);
    // Snapshot the just-replaced state so the rollback itself is
    // undoable — bumps the cap-trim, but that's the intended trade-off.
    await pushVersion(prev);
    return restored;
  });
}

// ── Sync cache (for the manifest's synchronous `tools` getter) ────────

// REL-01: keyed by tenant — a single global slot leaked one tenant's tools
// into another tenant's tools/list on a warm lambda.
const _syncCache = new TenantCache<CustomTool[]>();

/** Return the in-memory snapshot. The manifest reads this on every
 *  access; the registry's `refresh` hook keeps it warm. */
export function listCustomToolsSync(): CustomTool[] {
  return _syncCache.get() ?? [];
}

/** Refresh the sync cache from the authoritative store. Idempotent. */
export async function primeCustomToolsCache(): Promise<void> {
  try {
    _syncCache.set(await readRaw());
  } catch (err) {
    // Q-01: keep the last good snapshot on a transient KV error instead of
    // making every custom tool vanish from tools/list.
    console.error(`[Kebab MCP] custom tools cache refresh failed: ${toMsg(err)}`);
    if (_syncCache.get() === undefined) _syncCache.set([]);
  }
}

/** Test-only — drop the cache so tests don't leak state across files. */
export function _resetCustomToolsCacheForTests(): void {
  _syncCache.clear();
}
