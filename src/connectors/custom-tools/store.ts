import { getContextKVStore } from "@/core/request-context";
import {
  customToolSchema,
  customToolWriteSchema,
  type CustomTool,
  type CustomToolWriteInput,
} from "./types";
import { validateTemplate } from "./expression";

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
