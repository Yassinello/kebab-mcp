import { createHmac, createHash, timingSafeEqual } from "crypto";
import { getContextKVStore } from "@/core/request-context";
import {
  composeRequestPipeline,
  rehydrateStep,
  rateLimitStep,
  bodyParseStep,
  type PipelineContext,
} from "@/core/pipeline";

/** Maximum webhook payload size: 1 MB. */
const MAX_PAYLOAD_BYTES = 1_048_576;

/**
 * Webhook receiver endpoint.
 *
 * POST /api/webhook/:name
 *
 * Validates `name` against MYMCP_WEBHOOKS allowlist (comma-separated).
 * Optional HMAC-SHA256 signature verification via MYMCP_WEBHOOK_SECRET_<NAME>.
 * Stores payload in KV at `webhook:last:<name>`.
 *
 * v0.11 Phase 41: pipeline provides rehydrate + IP-keyed rate-limit +
 * body-parse. HMAC signature check stays inline (route-specific). The
 * legacy `BOOTSTRAP_EXEMPT:` marker was removed — rehydrate now runs
 * via the pipeline's `rehydrateStep`.
 *
 * PIPE-04 rate-limit scope: 30/min/IP (opt-in via MYMCP_RATE_LIMIT_ENABLED).
 * Anonymous caller surface — IP is the right key.
 */

function getAllowedWebhooks(): Set<string> {
  const raw = process.env.MYMCP_WEBHOOKS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function verifySignature(body: string, name: string, signature: string): boolean {
  const envKey = `MYMCP_WEBHOOK_SECRET_${name.toUpperCase().replace(/-/g, "_")}`;
  const secret = process.env[envKey];
  if (!secret) return false;

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  // Hash both sides to fixed length before comparing — prevents timing leak
  // on length mismatch (timingSafeEqual throws on different-length buffers).
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(signature).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

async function webhookHandler(ctx: PipelineContext): Promise<Response> {
  const request = ctx.request;
  const routeCtx = ctx.routeParams as { params: Promise<{ name: string }> };
  const { name } = await routeCtx.params;
  const normalizedName = name.trim().toLowerCase();

  // Validate against allowlist
  const allowed = getAllowedWebhooks();
  if (!allowed.has(normalizedName)) {
    return new Response(JSON.stringify({ error: "Webhook not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // bodyParseStep already buffered the body, honored Content-Length + stream
  // size limits, and parsed JSON best-effort. `ctx.parsedBody` is either a
  // parsed object or the raw string (the webhook-fallback shape). For HMAC
  // verification and KV storage we need the raw string, so re-serialize if
  // we received an object.
  const parsed = ctx.parsedBody;
  const body: string = typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? "");

  // Optional HMAC signature verification
  const secretEnvKey = `MYMCP_WEBHOOK_SECRET_${normalizedName.toUpperCase().replace(/-/g, "_")}`;
  if (process.env[secretEnvKey]) {
    const signature = request.headers.get("x-webhook-signature");
    if (!signature || !verifySignature(body, normalizedName, signature)) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Use the parsed object when JSON parse succeeded; fall back to the raw
  // string for non-JSON payloads (form-encoded, raw text).
  const payload = typeof parsed === "object" && parsed !== null ? parsed : body;

  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const receivedAt = new Date().toISOString();
  const entry = {
    payload,
    receivedAt,
    contentType,
  };

  // Store in KV — both `last` pointer and history ring buffer.
  // SEC-01b: getContextKVStore() scopes writes to the current tenant
  // (null = untenanted, same as before for default-tenant callers).
  // Webhook endpoints currently don't parse a tenant header; the
  // multi-tenant webhook routing story is v0.11 work. For now, all
  // webhook writes land under the null-tenant namespace, but the
  // getContextKVStore() wiring is in place so a future tenant-aware
  // middleware just works.
  const kv = getContextKVStore();
  const entryJson = JSON.stringify(entry);
  await kv.set(`webhook:last:${normalizedName}`, entryJson);

  // History: store timestamped entry + prune beyond limit
  const historyLimit = Math.max(
    1,
    parseInt(process.env.MYMCP_WEBHOOK_HISTORY_SIZE ?? "10", 10) || 10
  );
  const ts = Date.now();
  await kv.set(`webhook:history:${normalizedName}:${ts}`, entryJson);

  // Prune: list all history keys for this webhook and remove oldest beyond limit
  const historyPrefix = `webhook:history:${normalizedName}:`;
  const historyKeys = await kv.list(historyPrefix);
  if (historyKeys.length > historyLimit) {
    // Sort by timestamp (ascending) and delete the oldest
    const sorted = historyKeys
      .map((k) => ({ key: k, ts: parseInt(k.slice(historyPrefix.length), 10) }))
      .sort((a, b) => a.ts - b.ts);
    const toDelete = sorted.slice(0, sorted.length - historyLimit);
    await Promise.all(toDelete.map(({ key }) => kv.delete(key)));
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export const POST = composeRequestPipeline(
  [
    rehydrateStep,
    rateLimitStep({ scope: "webhook", keyFrom: "ip", limit: 30 }),
    bodyParseStep({ maxBytes: MAX_PAYLOAD_BYTES }),
  ],
  webhookHandler
);
