/**
 * Phase 71 / Plan 71-01 (UNI-20) — global kill switch for Unipile LinkedIn write tools.
 *
 * D-86: Setting `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true` (or the legacy
 *   alias `LINKEDIN_TOOLS_DISABLED=true`) refuses ALL 4 LinkedIn write tools
 *   (send_connection, send_message, send_inmail, engage) at Step -1 — BEFORE
 *   Step 0a account-resolve. Reads (get_relationship_status, list_pending)
 *   stay live. Operator's emergency brake without redeploy.
 *
 * D-88: AuditResult enum gains `error_writes_disabled` member; manifest
 *   `testConnection()`/`probe()` reports `writes_disabled: boolean` so the
 *   `/config → Connectors` tile can render the warning state.
 *
 * D-89: Read via `getConfig()` (NOT `process.env` direct) so per-request
 *   hydration picks up runtime env changes on the next call. Enforced by
 *   ESLint rule `kebab/no-direct-process-env`.
 *
 * Coalesce order: PRIMARY wins. If both `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED`
 *   and `LINKEDIN_TOOLS_DISABLED` are set, the primary's value is used
 *   (`??` semantic — undefined falls through, defined values short-circuit).
 *
 * Truthy values: `"true"` and `"1"` ONLY — explicit list. An empty string is
 *   "set but disabled" per Unix conventions; "false"/"0"/anything-else also
 *   returns false. No `Boolean(v)` coercion.
 */

import { getConfig } from "@/core/config-facade";

function isTruthy(v: string | undefined): boolean {
  return v === "true" || v === "1";
}

/**
 * Spec v2 (ADR 0002) — global switch covering BOTH channels. Checked by
 * `isWritesDisabled()` and `isWhatsappWritesDisabled()`.
 */
function isAllWritesDisabled(): boolean {
  return isTruthy(getConfig("KEBAB_UNIPILE_WRITES_DISABLED"));
}

/** LinkedIn writes disabled (channel switch, legacy alias, or global switch). */
export function isWritesDisabled(): boolean {
  const v =
    getConfig("KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED") ?? getConfig("LINKEDIN_TOOLS_DISABLED");
  return isTruthy(v) || isAllWritesDisabled();
}

/** WhatsApp writes disabled (channel switch or global switch). */
export function isWhatsappWritesDisabled(): boolean {
  return isTruthy(getConfig("KEBAB_UNIPILE_WHATSAPP_WRITES_DISABLED")) || isAllWritesDisabled();
}

export function isChannelWritesDisabled(channel: "LINKEDIN" | "WHATSAPP"): boolean {
  return channel === "WHATSAPP" ? isWhatsappWritesDisabled() : isWritesDisabled();
}
