/**
 * Phase 68 / Plan 05 / Task 1 — CRM bridge SKELETON (D-01 hard constraint).
 *
 * Six exports:
 *  - `CrmOutboxStatus` — extensible status enum. Phase 68 only emits 'pending'.
 *  - `CrmOutboxRow` — locked outbox row shape. Phase 70 will extend with
 *    `last_attempt_at`, `attempts`, `next_retry_at`, `error?` — DO NOT add
 *    those fields here; they belong to the retry cron.
 *  - `CrmAdapter` — public interface phase 70 will implement against. Tool
 *    handlers (Plan 06) depend on this contract, not on the concrete class.
 *  - `TwentyAdapterSkeleton` — phase 68's only implementation. Writes the
 *    outbox row with status='pending' and STOPS. No HTTP, no HMAC, no env
 *    var reads beyond getContextKVStore (which routes through the existing
 *    tenant-prefix machinery — see D-18).
 *  - `crmBridge` — singleton instance of TwentyAdapterSkeleton. Default
 *    consumer style: `import { crmBridge } from "@/connectors/unipile/lib/crm-bridge"`.
 *  - `writeOutboxRow(auditId, crmLog)` — free-function convenience for tool
 *    handlers that prefer not to import the singleton.
 *
 * Tenant isolation: ALL KV access goes through `getContextKVStore()` (D-18).
 * On-disk keys become `tenant:<id>:unipile:outbox:<audit_id>`.
 *
 * D-01 hard constraint (locked, enforced by `crm-bridge.test.ts`'s static
 * source-code check):
 *   This module contains NO `fetch(`, NO `createHmac`, NO env-var reads
 *   beyond what getContextKVStore needs, NO references to
 *   `UNIPILE_CRM_WEBHOOK_URL` or `UNIPILE_CRM_WEBHOOK_SECRET_*` in runtime
 *   code. The D-02 / D-03 / D-04 phase 70 contracts ARE documented in
 *   comments so phase 70's implementation has a clear contract — but the
 *   implementation itself is empty/stub.
 *
 * Phase 70 handoff: see TwentyAdapter contract notes on `CrmAdapter` below.
 */

import { getContextKVStore } from "@/core/request-context";

/**
 * Status of a CRM outbox row.
 *
 * - "pending": initial state (D-01 — phase 68 stops here, no send attempted).
 * - "sent":    phase 70 will set this when the webhook POST returns 2xx.
 * - "failed":  phase 70 transient failure, will be retried per D-04
 *              exponential cron (1min, 5min, 30min).
 * - "dead":    phase 70 after 3 retry failures. Surfaced in the /config
 *              dashboard with the D-17 CRM-tile semantics ("Erreur d'envoi -
 *              retry", red icon, NOT an ambiguous orange/pending state).
 */
export type CrmOutboxStatus = "pending" | "sent" | "failed" | "dead";

/**
 * Outbox row schema. Phase 70 will extend with attempt-tracking fields
 * (last_attempt_at, attempts, next_retry_at, error?). Do NOT add those here;
 * they belong to the retry cron's domain.
 */
export interface CrmOutboxRow {
  audit_id: string;
  status: CrmOutboxStatus;
  crm_log: unknown; // free-form CRM payload, owned by the tool caller
  queued_at: string; // ISO-8601 UTC
}

/**
 * Interface for CRM bridge adapters. Phase 68 ships ONE implementation:
 * `TwentyAdapterSkeleton` (writes outbox row with status='pending', no
 * network call).
 *
 * Phase 70 will land a real `TwentyAdapter` that:
 *   1. Reads the per-tenant webhook URL (D-02 — env-var pattern
 *      `UNIPILE_CRM_WEBHOOK_URL`, resolved via getConfig() at call time).
 *   2. Reads the per-tenant HMAC secret (D-03 — env-var pattern
 *      `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>`, e.g.
 *      `UNIPILE_CRM_WEBHOOK_SECRET_CADENS_001`).
 *   3. Computes HMAC-SHA256 over the canonical request body using
 *      `node:crypto.createHmac` and verifies via `timingSafeEqual` where
 *      applicable.
 *   4. POSTs to the webhook URL with an `Authorization: HMAC <sig>` header.
 *   5. On 2xx -> updates the row to status='sent'.
 *   6. On non-2xx / network failure -> updates the row to status='failed'
 *      with `attempts++`. The retry cron picks it up per D-04 schedule
 *      (1min, 5min, 30min). After 3 failures -> status='dead'.
 *
 * A separate phase 70 retry handler (cron route or background worker) will
 * scan `unipile:outbox:*` keys with status in {pending, failed} and process
 * them. Phase 68 only WRITES the rows; the retry cron is out of scope here.
 *
 * Why an interface lives here in phase 68: tool handlers in Plan 06 depend
 * on `CrmAdapter`, not on the concrete `TwentyAdapterSkeleton`. Phase 70 can
 * drop in a real implementation without touching `linkedin_send_connection.ts`.
 */
export interface CrmAdapter {
  writeOutbox(auditId: string, payload: { crm_log: unknown }): Promise<void>;
}

/**
 * Phase 68 skeleton implementation: writes the outbox row with status='pending'
 * and stops. NO HTTP, NO HMAC, NO env-var reads beyond what getContextKVStore
 * itself requires.
 *
 * The actual Twenty integration (HTTP POST + HMAC signing + per-tenant
 * secrets + retry/cron) lands in phase 70 per D-01 / D-02 / D-03 / D-04.
 */
export class TwentyAdapterSkeleton implements CrmAdapter {
  async writeOutbox(auditId: string, payload: { crm_log: unknown }): Promise<void> {
    const row: CrmOutboxRow = {
      audit_id: auditId,
      status: "pending",
      crm_log: payload.crm_log,
      queued_at: new Date().toISOString(),
    };
    const kv = getContextKVStore();
    // REL-10 (2026-11 audit): no consumer drains this outbox yet (the CRM
    // adapter is a skeleton), so rows used to accumulate forever. Keep them
    // 30 days — ample for a future retry worker — then let KV expire them.
    await kv.set(`unipile:outbox:${auditId}`, JSON.stringify(row), OUTBOX_TTL_SECONDS);
  }
}

const OUTBOX_TTL_SECONDS = 30 * 24 * 3600;

/**
 * Singleton instance used by tool handlers in Plan 06. Default consumer
 * style:
 *   `import { crmBridge } from "@/connectors/unipile/lib/crm-bridge";`
 *   `await crmBridge.writeOutbox(auditId, { crm_log });`
 */
export const crmBridge: CrmAdapter = new TwentyAdapterSkeleton();

/**
 * Convenience free-function form for tool handlers that prefer not to
 * import the singleton. Equivalent to
 * `crmBridge.writeOutbox(auditId, { crm_log: crmLog })`.
 */
export async function writeOutboxRow(auditId: string, crmLog: unknown): Promise<void> {
  return crmBridge.writeOutbox(auditId, { crm_log: crmLog });
}
