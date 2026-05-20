/**
 * bodyParseStep — PIPE-02.
 *
 * Reads the request body into memory with a bounded size limit, parses
 * JSON best-effort, and stores the result on `ctx.parsedBody`.
 *
 * Behavior (matches the inline bounded-read loop currently duplicated
 * in webhook/[name]/route.ts:69-100):
 *   - Content-Length > maxBytes → 413 short-circuit (no stream read)
 *   - Streamed bytes > maxBytes → reader.cancel() + 413
 *   - JSON.parse success → `ctx.parsedBody = parsedObject`
 *   - JSON.parse failure → `ctx.parsedBody = rawString` (preserves the
 *     webhook route's fallback for non-JSON bodies)
 *   - Empty body → `ctx.parsedBody = ""` (not null — keeps the type
 *     stable for downstream `typeof ctx.parsedBody === 'string'` checks)
 *   - Read error → 400 short-circuit
 *
 * Default maxBytes is 1 MiB; callers that want a tighter limit pass it
 * via the options object.
 */

import type { Step } from "./types";

export interface BodyParseOptions {
  /** Maximum bytes to buffer. Default 1 MiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1_048_576;

export function bodyParseStep(options: BodyParseOptions = {}): Step {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return async (ctx, next) => {
    const req = ctx.request;

    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return new Response(JSON.stringify({ error: "Payload too large" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body = "";
    if (req.body) {
      const reader = req.body.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let totalBytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            // best-effort cancel — ignore failures so we can still
            // respond with 413 cleanly
            try {
              await reader.cancel();
            } catch {
              // reader may already be closed
            }
            return new Response(JSON.stringify({ error: "Payload too large" }), {
              status: 413,
              headers: { "Content-Type": "application/json" },
            });
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode()); // flush
      } catch {
        return new Response(JSON.stringify({ error: "Failed to read body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      body = chunks.join("");
    }

    // Preserve the exact raw bytes for byte-exact HMAC verification. Webhook
    // routes must sign over this, never over JSON.stringify(parsedBody).
    ctx.rawBody = body;

    // Best-effort JSON parse, fall back to raw string so non-JSON
    // webhook payloads (form-encoded, raw text) still land on ctx.parsedBody.
    if (body.length === 0) {
      ctx.parsedBody = "";
    } else {
      try {
        ctx.parsedBody = JSON.parse(body);
      } catch {
        ctx.parsedBody = body;
      }
    }

    return next();
  };
}
