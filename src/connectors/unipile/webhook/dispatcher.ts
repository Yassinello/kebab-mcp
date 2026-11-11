/**
 * Phase 70 / Plan 01 / Task 2 — Webhook event dispatcher (D-55 / D-63).
 *
 * Routes a verified Unipile webhook payload to the correct handler.
 * Plan 01 ships the dispatcher and 3 NO-OP handler hooks; Plan 02 wires
 * the real handlers by mutating `_handlers.{messageReceived,newRelation,
 * accountStatus}` from a `handlers/index.ts` barrel (side-effect import
 * from the route).
 *
 * Why the hook indirection (mutable object instead of direct imports of
 * `./handlers/...`):
 *   - Avoids cyclic import between the dispatcher and per-event handlers
 *     that will themselves call `resolveTenantFromAccountId` (which lives
 *     in this file).
 *   - Lets Plan 01 ship + be unit-testable BEFORE Plan 02 writes the
 *     real handlers — dispatcher tests spy on `_handlers.X` directly.
 *   - Plan 02 simply imports `{ _handlers }` from this module and assigns
 *     real implementations during the side-effect `import "./handlers"`
 *     in the route. Zero coupling at the type level.
 *
 * Idempotency key derivation (D-54 / Pitfall 7):
 *   Unipile has NO unified `event_id` across event types. `message_id` is
 *   per-message unique for `message_received`. `new_relation` needs a
 *   composite of `account_id:user_provider_id` (Unipile may emit the same
 *   relation row twice if the underlying connection-accept retries). The
 *   `account_status` webhook has NO `event` field at all (detected via
 *   the `account_status` string field); composite key includes a timestamp
 *   so two transitions OK → ERROR → OK on the same account aren't deduped
 *   into a single delivery.
 *
 * Echo-skip (D-63):
 *   `message_received` is delivered for BOTH inbound AND outbound — the
 *   `is_sender: true` flag means it's our own outbound. Inbound enrichment
 *   logic should never see these. Dispatcher drops them with a debug log
 *   (the per-message handler in Plan 02 also double-checks as defense-
 *   in-depth).
 */
import { getLogger } from "@/core/logging";
import { getAccountTenant, writeAccountTenantMapping } from "./account-tenant-index";

const log = getLogger("CONNECTOR:unipile-webhook");

/** Handler signature — receives the entire verified payload. */
export type WebhookEventHandler = (payload: Record<string, unknown>) => Promise<void>;

/**
 * Default no-op handler — logs a warning. Plan 02 replaces these by
 * assigning real implementations to `_handlers.{messageReceived, ...}`
 * via a side-effect import from the route.
 */
const noopHandler: WebhookEventHandler = async (p) => {
  log.warn("[CONNECTOR:unipile-webhook] handler not registered", {
    event: p.event ?? p.account_status,
  });
};

/**
 * Mutable hook table — Plan 02 mutates these to wire real handlers.
 * Export shape is `_handlers` (underscore prefix = "internal" — exported
 * for tests and the Plan-02 registration site only).
 */
export const _handlers: {
  messageReceived: WebhookEventHandler;
  newRelation: WebhookEventHandler;
  accountStatus: WebhookEventHandler;
} = {
  messageReceived: noopHandler,
  newRelation: noopHandler,
  accountStatus: noopHandler,
};

/**
 * Spec v2 R8 — events dropped before ANY KV work (idempotency write included):
 *  - outbound echoes (`is_sender: true`, D-63);
 *  - `message_received` from WhatsApp accounts: a personal WhatsApp (busy
 *    groups) would otherwise cost one idempotency key + one 90-day audit row
 *    per inbound message — Upstash quota burn with no business value (the
 *    D-63 reply correlation is a LinkedIn prospection feature).
 */
export function isIgnoredEvent(p: Record<string, unknown>): boolean {
  if (p.event !== "message_received") return false;
  if (p.is_sender === true) return true;
  const type = typeof p.account_type === "string" ? p.account_type.toUpperCase() : "";
  return type === "WHATSAPP";
}

/**
 * Derive the idempotency key for a webhook payload. Returns null on
 * malformed payloads (caller skips dedup write + still dispatches; the
 * handlers' own defensive checks drop bad shapes).
 */
export function getIdempotencyKey(p: Record<string, unknown>): string | null {
  const event = typeof p.event === "string" ? p.event : "";
  if (event === "message_received" && typeof p.message_id === "string") {
    return p.message_id;
  }
  if (
    event === "new_relation" &&
    typeof p.account_id === "string" &&
    typeof p.user_provider_id === "string"
  ) {
    return `${p.account_id}:${p.user_provider_id}`;
  }
  // account_status: detected by the `account_status` STRING field, NOT
  // by `payload.event` (the subscription schema omits the event field for
  // this source per RESEARCH §1).
  if (typeof p.account_id === "string" && typeof p.account_status === "string") {
    // L-06: a time-varying fallback (`String(Date.now())`) defeats
    // idempotency — every retry within the same second-ish window would
    // generate a NEW key, causing the dispatcher to burn KV writes on
    // duplicate processing of the same conceptual event. Use a stable
    // sentinel instead so the (account_id, status) tuple alone keys the
    // idempotency check when the upstream omits a timestamp.
    const ts = typeof p.timestamp === "string" ? p.timestamp : "no-ts";
    return `${p.account_id}:${p.account_status}:${ts}`;
  }
  return null;
}

/**
 * Route a verified payload to the appropriate handler. Fire-and-forget at
 * the call site — this function awaits its delegated handler, but the
 * route invokes it with `void dispatchEventAsync(payload).catch(log.error)`
 * so the 200 response ships before the handler resolves.
 *
 * Never throws — unknown event types log a warning and return.
 */
export async function dispatchEventAsync(payload: Record<string, unknown>): Promise<void> {
  const event = typeof payload.event === "string" ? payload.event : "";

  // D-63: skip outbound echoes. Unipile sends `message_received` for BOTH
  // inbound AND outbound; `is_sender: true` marks our own outbound.
  if (isIgnoredEvent(payload)) {
    log.debug("[CONNECTOR:unipile-webhook] skip ignored message event", {
      message_id: payload.message_id,
      account_type: payload.account_type,
      is_sender: payload.is_sender,
    });
    return;
  }

  switch (event) {
    case "message_received":
      return _handlers.messageReceived(payload);
    case "new_relation":
      return _handlers.newRelation(payload);
    default:
      // account_status path: detected via the `account_status` string field,
      // NOT via `payload.event` (which is absent on this source).
      if (typeof payload.account_status === "string") {
        return _handlers.accountStatus(payload);
      }
      log.warn("[CONNECTOR:unipile-webhook] unknown event type", {
        event,
        keys: Object.keys(payload),
      });
  }
}

/**
 * Resolve the tenant that owns `accountId` via the root-scope reverse
 * index. Returns null when no mapping exists — caller (typically a
 * handler) drops the event with a warn log.
 */
export async function resolveTenantFromAccountId(accountId: string): Promise<string | null> {
  return getAccountTenant(accountId);
}

/**
 * Record an `accountId → tenantId` mapping. Exposed for the operator
 * dashboard's account-claim flow (not used in this phase; the dispatcher
 * and Plan-02 handlers MAY also call this opportunistically when a
 * payload carries the tenant context).
 */
export async function claimAccountForTenant(accountId: string, tenantId: string): Promise<void> {
  await writeAccountTenantMapping(accountId, tenantId);
}
