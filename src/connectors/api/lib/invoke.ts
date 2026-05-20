import type { ApiConnection, ApiTool } from "../store";
import { fetchWithTimeout } from "@/core/fetch-utils";
import { isPublicUrl } from "@/core/url-safety";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";

/**
 * Runtime invocation for custom API tools.
 *
 * Flow:
 * 1. Resolve pathTemplate / queryTemplate / bodyTemplate using {{arg}} syntax.
 * 2. Concatenate connection.baseUrl + resolvedPath.
 * 3. SSRF-check the final URL (isPublicUrl). Override via
 *    KEBAB_API_CONN_ALLOW_LOCAL=1 for local dev.
 * 4. Merge connection.headers + auth headers.
 * 5. fetchWithTimeout(url, init, tool.timeoutMs).
 * 6. Return a text-safe body summary (no binary leak).
 */

const MAX_RESPONSE_BYTES = 512 * 1024;

function interpolate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, name) => {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      const v = args[name];
      return v === null || v === undefined ? "" : String(v);
    }
    return "";
  });
}

function interpolateQuery(
  template: Record<string, string>,
  args: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(template)) {
    const rendered = interpolate(v, args);
    if (rendered !== "") out[k] = rendered;
  }
  return out;
}

function authHeaders(auth: ApiConnection["auth"]): Record<string, string> {
  switch (auth.type) {
    case "none":
      return {};
    case "bearer":
      return { Authorization: `Bearer ${auth.token}` };
    case "api_key_header":
      return { [auth.headerName]: auth.value };
    case "basic": {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
  }
}

export interface InvokeResult {
  status: number;
  ok: boolean;
  body: string;
  truncated: boolean;
  url: string;
}

let allowLocalProdWarned = false;

function allowLocal(): boolean {
  const flag = getConfig("KEBAB_API_CONN_ALLOW_LOCAL");
  if (flag !== "1" && flag !== "true") return false;

  // SEC-A-02: refuse the dev-convenience flag in production. Vercel sets
  // VERCEL=1 on every deployment; NODE_ENV=production is the standard
  // Node signal. Either rules it out — opening loopback / RFC1918 in
  // prod would expose cloud metadata (169.254.169.254) and internal
  // services to any caller able to define a custom API connection.
  const isProd = getConfig("NODE_ENV") === "production" || getConfig("VERCEL") === "1";
  if (isProd) {
    if (!allowLocalProdWarned) {
      console.error(
        "[Kebab MCP Security] KEBAB_API_CONN_ALLOW_LOCAL is ignored in production. " +
          "This flag is dev-only because it bypasses SSRF protection."
      );
      allowLocalProdWarned = true;
    }
    return false;
  }
  return true;
}

/** Test-only: reset the prod warning dedupe. */
export function __resetAllowLocalWarn(): void {
  allowLocalProdWarned = false;
}

/** Join baseUrl with a path, safely. */
function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  if (!path) return trimmedBase;
  const leading = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${leading}`;
}

export async function invokeApiTool(
  connection: ApiConnection,
  tool: ApiTool,
  args: Record<string, unknown>
): Promise<InvokeResult> {
  // 1. Build URL + query
  const path = interpolate(tool.pathTemplate, args);
  const url = new URL(joinUrl(connection.baseUrl, path));
  const query = interpolateQuery(tool.queryTemplate, args);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }

  // 2. SSRF guard — resolve DNS (closes the DNS-rebind hole: a public
  // hostname whose A/AAAA record points at 169.254.169.254 / 10.x / loopback
  // would otherwise slip past a syntactic-only check). The added lookup
  // latency is acceptable on these low-frequency, admin-defined fetches.
  const safety = await isPublicUrl(url.toString(), {
    allowLoopback: allowLocal(),
    allowPrivateNetwork: allowLocal(),
    resolveDns: true,
  });
  if (!safety.ok) {
    throw new Error(`URL rejected: ${safety.error.message}`);
  }

  // 3. Body
  let body: string | undefined;
  const hasBody = tool.method !== "GET" && tool.method !== "DELETE";
  if (hasBody && tool.bodyTemplate.trim()) {
    body = interpolate(tool.bodyTemplate, args);
  }

  // 4. Headers
  const headers: Record<string, string> = {
    Accept: "application/json, */*",
    ...connection.headers,
    ...authHeaders(connection.auth),
  };
  if (body !== undefined && !headers["Content-Type"]) {
    // Best-effort Content-Type when the body parses as JSON.
    try {
      JSON.parse(body);
      headers["Content-Type"] = "application/json";
    } catch {
      headers["Content-Type"] = "text/plain; charset=utf-8";
    }
  }

  // 5. Fetch with timeout
  const timeoutMs = tool.timeoutMs || connection.timeoutMs || 30000;
  const init: RequestInit = {
    method: tool.method,
    headers,
  };
  if (body !== undefined) init.body = body;
  const res = await fetchWithTimeout(url.toString(), init, timeoutMs);

  // 6. Safe body read (capped)
  let text: string;
  let truncated = false;
  try {
    const buf = await res.arrayBuffer();
    truncated = buf.byteLength > MAX_RESPONSE_BYTES;
    const view = truncated ? new Uint8Array(buf.slice(0, MAX_RESPONSE_BYTES)) : new Uint8Array(buf);
    text = new TextDecoder("utf-8", { fatal: false }).decode(view);
  } catch {
    text = "";
  }

  return {
    status: res.status,
    ok: res.ok,
    body: text,
    truncated,
    url: url.toString(),
  };
}

/**
 * Helper used by the "Test connection" UI button — probes baseUrl without
 * hitting any tool. Returns { ok, status, ms, error }.
 */
export async function testApiConnection(
  connection: ApiConnection,
  probePath: string = "/"
): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
  const url = joinUrl(connection.baseUrl, probePath);
  const safety = await isPublicUrl(url, {
    allowLoopback: allowLocal(),
    allowPrivateNetwork: allowLocal(),
    resolveDns: true,
  });
  if (!safety.ok) {
    return { ok: false, ms: 0, error: safety.error.message };
  }
  const headers: Record<string, string> = {
    Accept: "application/json, */*",
    ...connection.headers,
    ...authHeaders(connection.auth),
  };
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      url,
      { method: "GET", headers },
      connection.timeoutMs || 30000
    );
    const ms = Date.now() - started;
    return { ok: res.ok, status: res.status, ms };
  } catch (err) {
    const ms = Date.now() - started;
    return { ok: false, ms, error: toMsg(err) };
  }
}

// Re-export for tests
export { interpolate };
