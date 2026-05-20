/**
 * Phase 70 / Plan 01 / Task 2 — Unipile webhook ingress route (UNI-12).
 *
 * POST /api/unipile/webhook
 *
 * Receives webhook deliveries from the Unipile tenant for the 3
 * subscribed sources (`messaging`, `account_status`, `users`). Bootstrap
 * via `npx tsx scripts/setup-unipile-webhooks.ts` after deploy
 * (idempotent — re-running is safe).
 *
 * Pipeline:
 *  1. `rehydrateStep` — credentials loaded from KV
 *  2. `bodyParseStep({maxBytes: 256KB})` — Unipile bodies are 1-2KB;
 *     256 KB is generous + DoS-protective. The body parser is JSON-first
 *     regardless of Content-Type, which closes D-77 (Unipile sends
 *     `Content-Type: application/x-www-form-urlencoded` even when the
 *     body IS valid JSON — verified empirically 2026-05-18).
 *
 * Handler steps:
 *  A. Resolve `UNIPILE_WEBHOOK_SECRET` via `getConfig()` — return 503
 *     `{error:"webhook_not_configured"}` if missing (signal-to-noise:
 *     503 = "I'm not even set up" vs 401 = "your secret is wrong").
 *  B. Verify signature via the dual-mode verifier (D-52). HMAC mismatch
 *     is REJECTED hard — no fallthrough to static (downgrade-attack
 *     guard, see verifier.ts).
 *  C. 24h KV idempotency via `setIfNotExists` on `unipile:webhook:event:<id>`
 *     (D-54). ROOT-scope KV because the route has no tenant context until
 *     the dispatcher resolves `account_id` → tenant via the reverse index.
 *  D. Fire-and-forget dispatch (D-55). 200 returns IMMEDIATELY; handler
 *     work runs after the response. Vercel keeps the lambda alive ~30s
 *     post-response, more than enough for the 1-2s per-handler budget.
 *
 * KV ALLOWLIST: this file uses `getKVStore()` (ROOT scope) and is
 * registered in `tests/contract/kv-allowlist.test.ts` — see that file's
 * comment block on the Phase 70 entries for the rationale.
 *
 * Logger tag: `CONNECTOR:unipile-webhook` (distinct from `CONNECTOR:unipile`
 * so log filters work per surface).
 */
import {
  composeRequestPipeline,
  rehydrateStep,
  bodyParseStep,
  type PipelineContext,
} from "@/core/pipeline";
import { getKVStore } from "@/core/kv-store";
import { getConfig } from "@/core/config-facade";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
import { verifyUnipileWebhook } from "@/connectors/unipile/webhook/verifier";
import { dispatchEventAsync, getIdempotencyKey } from "@/connectors/unipile/webhook/dispatcher";
// Side-effect import: Plan 02 will mutate `_handlers` from this barrel.
// Plan 01 ships a `handlers/index.ts` that does `export {};` so the
// import resolves cleanly without registering anything (dispatcher's
// `noopHandler` is the active path until Plan 02 lands).
import "@/connectors/unipile/webhook/handlers";

const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB — DoS-protective + 100× generous
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24h per D-54

const log = getLogger("CONNECTOR:unipile-webhook");

async function unipileWebhookHandler(ctx: PipelineContext): Promise<Response> {
  const secret = getConfig("UNIPILE_WEBHOOK_SECRET");
  if (!secret) {
    log.warn("[CONNECTOR:unipile-webhook] secret unset — returning 503");
    return Response.json({ error: "webhook_not_configured" }, { status: 503 });
  }

  // bodyParseStep buffers the exact raw bytes on ctx.rawBody (before any
  // JSON parse) and the parsed object on ctx.parsedBody. HMAC must verify
  // over the EXACT bytes — re-serializing the parsed object via
  // JSON.stringify would not byte-reproduce the sender's payload (key order,
  // whitespace, unicode escaping), so the HMAC path would reject every
  // genuinely-signed delivery. Fall back to re-serialization only if rawBody
  // is somehow absent (defensive; bodyParseStep always sets it).
  const parsed = ctx.parsedBody;
  const rawBody: string =
    typeof ctx.rawBody === "string"
      ? ctx.rawBody
      : typeof parsed === "string"
        ? parsed
        : JSON.stringify(parsed ?? "");

  // Signature verification (D-52 — dual mode).
  const verifyResult = verifyUnipileWebhook(rawBody, ctx.request.headers, secret);
  log.info("[CONNECTOR:unipile-webhook] auth attempt", {
    mode: verifyResult.mode,
    ok: verifyResult.ok,
  });
  if (!verifyResult.ok) {
    return Response.json(
      { error: "invalid_signature", reason: verifyResult.reason },
      { status: 401 }
    );
  }

  // Payload sanity check — must be an object after bodyParseStep's
  // best-effort JSON parse. Strings here mean Unipile sent non-JSON
  // (which would be a Unipile bug per the documented schema).
  if (typeof parsed !== "object" || parsed === null) {
    log.warn("[CONNECTOR:unipile-webhook] payload is not an object — rejecting");
    return Response.json({ error: "invalid_payload" }, { status: 400 });
  }
  const payload = parsed as Record<string, unknown>;

  // D-54 idempotency. Skip dedup write when no key can be derived (malformed
  // payload) — let the dispatcher's defensive checks log + drop. Note:
  // dispatcher still fires so log volume reflects all received events.
  const idemKey = getIdempotencyKey(payload);
  if (idemKey) {
    const kv = getKVStore();
    const setRes = await kv.setIfNotExists?.(`unipile:webhook:event:${idemKey}`, "1", {
      ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
    });
    if (setRes && !setRes.ok) {
      log.info("[CONNECTOR:unipile-webhook] duplicate event — dispatch skipped", {
        idemKey,
      });
      return Response.json({ ok: true, deduped: true }, { status: 200 });
    }
  }

  // D-55: return 200 fast, dispatch work (KV state updates) runs post-response
  // while Vercel keeps the lambda alive ~30s; its failure is logged below and
  // the caller (Unipile) does not depend on it.
  // fire-and-forget OK: webhook ACK must be sub-second; dispatch runs after the response
  void dispatchEventAsync(payload).catch((err) =>
    log.error("[CONNECTOR:unipile-webhook] dispatch failed", {
      err: toMsg(err),
      event: payload.event ?? payload.account_status,
    })
  );

  return Response.json({ ok: true }, { status: 200 });
}

export const POST = composeRequestPipeline(
  [
    rehydrateStep,
    // NO `rateLimitStep` — Unipile sends ≤5 webhooks/sec; the 30s lambda
    // response budget + KV idempotency are the rate-defense. A misbehaving
    // tenant flooding our route is mitigated by the 256 KB body limit +
    // dedup TTL preventing replay floods from re-triggering handlers.
    bodyParseStep({ maxBytes: MAX_PAYLOAD_BYTES }),
  ],
  unipileWebhookHandler
);
