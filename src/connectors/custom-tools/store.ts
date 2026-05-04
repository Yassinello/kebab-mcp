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
 */

const KV_KEY = "custom-tools:all";

// ── Write queue ───────────────────────────────────────────────────────

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
async function validateAllToolNames(steps: CustomToolWriteInput["steps"]): Promise<void> {
  const toolStepNames = new Set<string>();
  for (const step of steps) {
    if (step.kind === "tool") toolStepNames.add(step.toolName);
  }
  if (toolStepNames.size === 0) return;

  // Gather all known tool names + their owning pack id from every
  // connector (enabled + disabled). Mirrors the collision check in
  // app/api/admin/custom-tools/route.ts.
  const knownTools = new Map<string, string>();
  const states = await resolveRegistryAsync();
  for (const s of states) {
    if (s.enabled) {
      for (const t of s.manifest.tools) knownTools.set(t.name, s.manifest.id);
      continue;
    }
    const entry = ALL_CONNECTOR_LOADERS.find((e) => e.id === s.manifest.id);
    if (!entry) continue;
    try {
      const loaded = await entry.loader();
      for (const t of loaded.tools) knownTools.set(t.name, loaded.id);
    } catch {
      // Loader failure is non-fatal — over-allow on validation rather
      // than block writes on an unrelated import error.
    }
  }

  for (const name of toolStepNames) {
    const packId = knownTools.get(name);
    if (!packId) {
      throw new Error(`tool "${name}" does not exist or is not callable from custom tools`);
    }
    if (!CALLABLE_FROM_CUSTOM_TOOLS.has(packId)) {
      throw new Error(
        `tool "${name}" does not exist or is not callable from custom tools (pack "${packId}" is not in allowlist)`
      );
    }
  }
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
    await validateAllToolNames(parsed.steps);
    const all = await readRaw();
    if (all.some((t) => t.id === parsed.id)) {
      throw new Error(`a Custom Tool with id "${parsed.id}" already exists`);
    }
    const now = new Date().toISOString();
    const tool: CustomTool = {
      ...parsed,
      destructive: parsed.destructive ?? false,
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
    await validateAllToolNames(parsed.steps);
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
    const next: CustomTool = {
      ...prev,
      description: parsed.description,
      destructive: parsed.destructive ?? false,
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
