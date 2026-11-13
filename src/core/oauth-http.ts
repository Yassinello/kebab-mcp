/**
 * Kebab House phase 1 — small HTTP helpers shared by the OAuth routes.
 * Metadata and token endpoints are called by MCP clients from other
 * origins (browser-based clients included), hence permissive CORS without
 * credentials.
 */
import { OAuthError } from "./oauth";
import { toMsg } from "./error-utils";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function oauthErrorResponse(err: unknown): Response {
  if (err instanceof OAuthError) return jsonResponse(err.toJSON(), err.status);
  console.error(`[Kebab MCP] oauth error: ${toMsg(err)}`);
  return jsonResponse({ error: "server_error", error_description: "unexpected error" }, 500);
}

/** Read an OAuth form body (application/x-www-form-urlencoded), JSON tolerated. */
export async function readForm(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (text.length > 16 * 1024) throw new OAuthError("invalid_request", "body too large");
  if (type.includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) if (typeof v === "string") sp.set(k, v);
      return sp;
    } catch {
      throw new OAuthError("invalid_request", "malformed JSON body");
    }
  }
  return new URLSearchParams(text);
}
