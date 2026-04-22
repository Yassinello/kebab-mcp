/**
 * Canonical 500-response shape for admin / config routes.
 *
 * P1 fold-in (Phase 38, OBS-03-adjacent): before v0.10,
 * /api/config/env, /api/config/logs, /api/config/update returned raw
 * `err.message` to the client on 500-level failures. Upstream errors
 * (Upstash, Vercel API, git shell) can embed bearer tokens, path
 * fragments, or internal stack hints in their messages, so any such
 * leak is a small but real info disclosure.
 *
 * New shape: `{ error: "internal_error", errorId, hint }`. The full
 * sanitized error + errorId lands in the server log so an operator can
 * correlate by `errorId` without the client ever seeing the details.
 */

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getLogger } from "./logging";
import { toMsg } from "./error-utils";

/** Generate a short, non-reversible error ID for client/server correlation. */
export function generateErrorId(): string {
  return `err_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/**
 * Redact common secret patterns before logging. Upstream services
 * sometimes embed bearer tokens in HTTP error bodies; this function
 * strips the most common patterns (Bearer, slack xoxb/xoxp, openai
 * sk-, github ghp_, generic 32+ hex sequences). Not exhaustive — the
 * authoritative defense is to never log request bodies, which we
 * already don't.
 */
function sanitize(msg: string): string {
  return msg
    .replace(/Bearer\s+[\w-]+/gi, "Bearer <redacted>")
    .replace(/xox[bp]-[\w-]+/g, "<redacted-slack-token>")
    .replace(/sk-[\w]{20,}/g, "<redacted-openai-token>")
    .replace(/ghp_[\w]{20,}/g, "<redacted-github-token>")
    .replace(/[a-f0-9]{32,}/gi, "<redacted-hex>");
}

/**
 * Return a canonical 500-level response. Caller chooses the status
 * (most commonly 500, sometimes 503 for downstream outages).
 *
 * Never returns `err.message` to the client. The full sanitized error
 * + errorId are server-logged under the `[API:<route>]` tag.
 */
export function errorResponse(err: unknown, opts: { status: number; route: string }): Response {
  const errorId = generateErrorId();
  const message = toMsg(err);
  const sanitized = sanitize(message);
  getLogger(`API:${opts.route}`).error(sanitized, {
    errorId,
    stack: err instanceof Error ? err.stack : undefined,
  });
  return NextResponse.json(
    {
      error: "internal_error",
      errorId,
      hint: `Reference ${errorId} in server logs for details.`,
    },
    { status: opts.status }
  );
}
