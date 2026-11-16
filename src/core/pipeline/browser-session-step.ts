/**
 * browserSessionStep — audit 2026-11 (A2).
 *
 * For decisions only the owner may take in the dashboard (approving an
 * outgoing message, approving an OAuth client). The admin key is often the
 * same token an AI client holds (ADMIN_AUTH_TOKEN not set separately), so a
 * client could otherwise approve its own sends with `Authorization: Bearer`.
 *
 * This step runs BEFORE `authStep("admin")` and refuses:
 *   - any `Authorization` header and any `?token=` query parameter — the
 *     admin auth that follows can then only succeed with the dashboard
 *     cookie session (or the first-run claim on a fresh instance);
 *   - any request that is not a same-origin browser request: the
 *     `Sec-Fetch-Site` header must be `same-origin` when present, and
 *     otherwise the `Origin` header must be this instance's own origin.
 *
 * The Origin CSRF check of `authStep("admin")` still runs afterwards.
 */

import type { Step } from "./types";
import { publicOrigin } from "../oauth";

function refuse(error: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error, message }), {
    status: 403,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function ownHosts(request: Request): Set<string> {
  const hosts = new Set<string>();
  const host = request.headers.get("host");
  if (host) hosts.add(host.toLowerCase());
  try {
    hosts.add(new URL(request.url).host.toLowerCase());
  } catch {
    // ignore
  }
  try {
    hosts.add(new URL(publicOrigin(request)).host.toLowerCase());
  } catch {
    // ignore
  }
  return hosts;
}

/** True when the request comes from a page of this instance, in a browser. */
export function isSameOriginBrowserRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site.toLowerCase() === "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return ownHosts(request).has(new URL(origin).host.toLowerCase());
  } catch {
    return false;
  }
}

export const browserSessionStep: Step = async (ctx, next) => {
  const req = ctx.request;
  let hasQueryToken: boolean;
  try {
    hasQueryToken = new URL(req.url).searchParams.has("token");
  } catch {
    hasQueryToken = false;
  }
  if (req.headers.has("authorization") || hasQueryToken) {
    return refuse(
      "browser_session_required",
      "This decision can only be made in your Kebab House dashboard, signed in in the browser. Keys sent by apps are not accepted here."
    );
  }
  if (!isSameOriginBrowserRequest(req)) {
    return refuse(
      "same_origin_required",
      "This decision can only be made from a page of your Kebab House, in the browser."
    );
  }
  return next();
};
