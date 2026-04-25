import { randomBytes } from "crypto";
import { z } from "zod";
import { getContextKVStore } from "@/core/request-context";

/**
 * API Connections + Custom Tools persistence.
 *
 * Storage model (shared KV, single JSON blob per collection):
 * - `api:connections` — Array<ApiConnection>
 * - `api:tools`        — Array<ApiTool>
 *
 * Connections hold base URL + auth + default headers.
 * Tools reference a connectionId and carry method / path / templates.
 * The runtime (lib/invoke.ts) composes connection + tool at call time.
 */

// ── Auth ──────────────────────────────────────────────────────────────

export const apiAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
  z.object({
    type: z.literal("api_key_header"),
    headerName: z.string().min(1).max(200),
    value: z.string().min(1),
  }),
  z.object({
    type: z.literal("basic"),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
]);

export type ApiAuth = z.infer<typeof apiAuthSchema>;

// ── Connection ────────────────────────────────────────────────────────

export const apiConnectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  auth: apiAuthSchema,
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().min(1000).max(60000).default(30000),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ApiConnection = z.infer<typeof apiConnectionSchema>;

export const apiConnectionCreateSchema = apiConnectionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
// Update schema without defaults — omitted fields stay undefined so
// handlers can distinguish "not provided" from "intentionally empty".
export const apiConnectionUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  baseUrl: z.string().url().optional(),
  auth: apiAuthSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
});

export type ApiConnectionCreateInput = z.input<typeof apiConnectionCreateSchema>;
export type ApiConnectionUpdateInput = z.input<typeof apiConnectionUpdateSchema>;

// ── Tool ──────────────────────────────────────────────────────────────

export const apiToolArgSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "arg name must be a valid identifier"),
  description: z.string().default(""),
  required: z.boolean().default(false),
  type: z.enum(["string", "number", "boolean"]).default("string"),
});

export type ApiToolArg = z.infer<typeof apiToolArgSchema>;

export const apiToolSchema = z.object({
  id: z.string().min(1),
  connectionId: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "tool name must be lowercase slug"),
  description: z.string().default(""),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  pathTemplate: z.string().default(""),
  arguments: z.array(apiToolArgSchema).default([]),
  queryTemplate: z.record(z.string(), z.string()).default({}),
  bodyTemplate: z.string().default(""),
  /** Hints the MCP client: read tools are safe to auto-invoke;
   *  write/destructive should prompt. */
  readOrWrite: z.enum(["read", "write"]).default("read"),
  destructive: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(60000).default(30000),
  /** Optional JSON Schema for the tool's output — enables structuredContent
   *  attachment in ToolResult and server.registerTool() in the MCP transport. */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ApiTool = z.infer<typeof apiToolSchema>;

export const apiToolCreateSchema = apiToolSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
// Update schema without defaults — see connection update rationale above.
export const apiToolUpdateSchema = z.object({
  connectionId: z.string().min(1).optional(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "tool name must be lowercase slug")
    .optional(),
  description: z.string().optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  pathTemplate: z.string().optional(),
  arguments: z.array(apiToolArgSchema).optional(),
  queryTemplate: z.record(z.string(), z.string()).optional(),
  bodyTemplate: z.string().optional(),
  readOrWrite: z.enum(["read", "write"]).optional(),
  destructive: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

export type ApiToolCreateInput = z.input<typeof apiToolCreateSchema>;
export type ApiToolUpdateInput = z.input<typeof apiToolUpdateSchema>;

// ── KV keys ───────────────────────────────────────────────────────────

const CONN_KEY = "api:connections";
const TOOL_KEY = "api:tools";

// ── Write queues (per collection) ─────────────────────────────────────

let connQueue: Promise<void> = Promise.resolve();
let toolQueue: Promise<void> = Promise.resolve();

function enqueue<T>(queue: "conn" | "tool", fn: () => Promise<T>): Promise<T> {
  const current = queue === "conn" ? connQueue : toolQueue;
  const next = current.then(() => fn());
  const silent = next.then(
    () => undefined,
    () => undefined
  );
  if (queue === "conn") connQueue = silent;
  else toolQueue = silent;
  return next;
}

// ── Raw I/O ───────────────────────────────────────────────────────────

async function readConnectionsRaw(): Promise<ApiConnection[]> {
  const kv = getContextKVStore();
  const raw = await kv.get(CONN_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ApiConnection[] = [];
    for (const row of parsed) {
      const res = apiConnectionSchema.safeParse(row);
      if (res.success) out.push(res.data);
    }
    return out;
  } catch {
    return [];
  }
}

async function writeConnectionsRaw(rows: ApiConnection[]): Promise<void> {
  const kv = getContextKVStore();
  await kv.set(CONN_KEY, JSON.stringify(rows));
}

async function readToolsRaw(): Promise<ApiTool[]> {
  const kv = getContextKVStore();
  const raw = await kv.get(TOOL_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ApiTool[] = [];
    for (const row of parsed) {
      const res = apiToolSchema.safeParse(row);
      if (res.success) out.push(res.data);
    }
    return out;
  } catch {
    return [];
  }
}

async function writeToolsRaw(rows: ApiTool[]): Promise<void> {
  const kv = getContextKVStore();
  await kv.set(TOOL_KEY, JSON.stringify(rows));
}

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

// ── Connections API ───────────────────────────────────────────────────

export async function listApiConnections(): Promise<ApiConnection[]> {
  return readConnectionsRaw();
}

export async function getApiConnection(id: string): Promise<ApiConnection | null> {
  const all = await readConnectionsRaw();
  return all.find((c) => c.id === id) ?? null;
}

export function createApiConnection(input: ApiConnectionCreateInput): Promise<ApiConnection> {
  return enqueue("conn", async () => {
    const parsed = apiConnectionCreateSchema.parse(input);
    const all = await readConnectionsRaw();
    const now = new Date().toISOString();
    const conn: ApiConnection = {
      id: genId("conn"),
      name: parsed.name,
      baseUrl: parsed.baseUrl,
      auth: parsed.auth,
      headers: parsed.headers ?? {},
      timeoutMs: parsed.timeoutMs ?? 30000,
      createdAt: now,
      updatedAt: now,
    };
    all.push(conn);
    await writeConnectionsRaw(all);
    return conn;
  });
}

export function updateApiConnection(
  id: string,
  patch: ApiConnectionUpdateInput
): Promise<ApiConnection | null> {
  return enqueue("conn", async () => {
    const parsed = apiConnectionUpdateSchema.parse(patch);
    const all = await readConnectionsRaw();
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    const prev = all[idx];
    if (!prev) return null;
    const next: ApiConnection = {
      ...prev,
      updatedAt: new Date().toISOString(),
      name: parsed.name ?? prev.name,
      baseUrl: parsed.baseUrl ?? prev.baseUrl,
      auth: parsed.auth ?? prev.auth,
      headers: parsed.headers ?? prev.headers,
      timeoutMs: parsed.timeoutMs ?? prev.timeoutMs,
    };
    all[idx] = next;
    await writeConnectionsRaw(all);
    return next;
  });
}

export function deleteApiConnection(id: string): Promise<boolean> {
  return enqueue("conn", async () => {
    const all = await readConnectionsRaw();
    const next = all.filter((c) => c.id !== id);
    if (next.length === all.length) return false;
    await writeConnectionsRaw(next);
    return true;
  });
}

// ── Tools API ─────────────────────────────────────────────────────────

export async function listApiTools(): Promise<ApiTool[]> {
  return readToolsRaw();
}

export async function getApiTool(id: string): Promise<ApiTool | null> {
  const all = await readToolsRaw();
  return all.find((t) => t.id === id) ?? null;
}

export async function listApiToolsByConnection(connectionId: string): Promise<ApiTool[]> {
  const all = await readToolsRaw();
  return all.filter((t) => t.connectionId === connectionId);
}

/**
 * Synchronous snapshot used by the manifest at registry scan time.
 * Mirrors the pattern used by the skills connector. Returns [] on any
 * failure so registry scan stays resilient.
 */
export function listApiToolsSync(): ApiTool[] {
  // On a filesystem KV backend we *could* readFileSync here for parity
  // with listSkillsSync. For MVP simplicity — and because /api/[transport]
  // does an async registry resolve via resolveRegistryAsync() anyway —
  // we rely on primeApiToolsCache() below. The synchronous getter returns
  // a cached snapshot populated at registry resolve time.
  return _syncCache;
}

// Populated by primeApiToolsCache(), called at registry resolve time.
let _syncCache: ApiTool[] = [];

/** Refresh the sync cache used by listApiToolsSync. Idempotent. */
export async function primeApiToolsCache(): Promise<void> {
  try {
    _syncCache = await readToolsRaw();
  } catch {
    _syncCache = [];
  }
}

/** Reset the sync cache. Exposed for tests — prevents cross-test bleed. */
export function _resetApiToolsCacheForTests(): void {
  _syncCache = [];
}

export function createApiTool(input: ApiToolCreateInput): Promise<ApiTool> {
  return enqueue("tool", async () => {
    const parsed = apiToolCreateSchema.parse(input);
    const all = await readToolsRaw();
    // Reject duplicate names within the same connection.
    const clash = all.find((t) => t.connectionId === parsed.connectionId && t.name === parsed.name);
    if (clash) {
      throw new Error(`A tool named "${parsed.name}" already exists on this connection`);
    }
    const now = new Date().toISOString();
    const tool: ApiTool = {
      id: genId("tool"),
      connectionId: parsed.connectionId,
      name: parsed.name,
      description: parsed.description ?? "",
      method: parsed.method ?? "GET",
      pathTemplate: parsed.pathTemplate ?? "",
      arguments: parsed.arguments ?? [],
      queryTemplate: parsed.queryTemplate ?? {},
      bodyTemplate: parsed.bodyTemplate ?? "",
      readOrWrite: parsed.readOrWrite ?? "read",
      destructive: parsed.destructive ?? false,
      timeoutMs: parsed.timeoutMs ?? 30000,
      ...(parsed.outputSchema !== undefined ? { outputSchema: parsed.outputSchema } : {}),
      createdAt: now,
      updatedAt: now,
    };
    all.push(tool);
    await writeToolsRaw(all);
    _syncCache = all;
    return tool;
  });
}

export function updateApiTool(id: string, patch: ApiToolUpdateInput): Promise<ApiTool | null> {
  return enqueue("tool", async () => {
    const parsed = apiToolUpdateSchema.parse(patch);
    const all = await readToolsRaw();
    const idx = all.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const prev = all[idx];
    if (!prev) return null;
    const next: ApiTool = {
      ...prev,
      updatedAt: new Date().toISOString(),
      connectionId: parsed.connectionId ?? prev.connectionId,
      name: parsed.name ?? prev.name,
      description: parsed.description ?? prev.description,
      method: parsed.method ?? prev.method,
      pathTemplate: parsed.pathTemplate ?? prev.pathTemplate,
      arguments: parsed.arguments ?? prev.arguments,
      queryTemplate: parsed.queryTemplate ?? prev.queryTemplate,
      bodyTemplate: parsed.bodyTemplate ?? prev.bodyTemplate,
      readOrWrite: parsed.readOrWrite ?? prev.readOrWrite,
      destructive: parsed.destructive ?? prev.destructive,
      timeoutMs: parsed.timeoutMs ?? prev.timeoutMs,
      ...(parsed.outputSchema !== undefined ? { outputSchema: parsed.outputSchema } : {}),
    };
    all[idx] = next;
    await writeToolsRaw(all);
    _syncCache = all;
    return next;
  });
}

export function deleteApiTool(id: string): Promise<boolean> {
  return enqueue("tool", async () => {
    const all = await readToolsRaw();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length) return false;
    await writeToolsRaw(next);
    _syncCache = next;
    return true;
  });
}

/** Remove all tools attached to a connection. Called on connection delete. */
export function deleteApiToolsForConnection(connectionId: string): Promise<number> {
  return enqueue("tool", async () => {
    const all = await readToolsRaw();
    const next = all.filter((t) => t.connectionId !== connectionId);
    const removed = all.length - next.length;
    if (removed > 0) {
      await writeToolsRaw(next);
      _syncCache = next;
    }
    return removed;
  });
}
