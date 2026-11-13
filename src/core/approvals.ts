/**
 * TRU-04 (Kebab House phase 1) — out-of-band approval of outgoing actions.
 *
 * A `confirm: true` flag can be set by the model itself, so it proves
 * nothing about the user's intent (a prompt-injected model approves its own
 * sends). In `link` mode a write tool instead:
 *
 *   1. stores the EXACT payload it would execute under a random preview id
 *      (tenant-scoped KV, 15 min TTL) and returns a signed approval link;
 *   2. the user opens `/approve/<id>` (admin auth) and approves or rejects;
 *   3. the tool's next call with `preview_id` executes the STORED payload —
 *      never arguments supplied by the model on that call — exactly once.
 *
 * This module is the transport-agnostic store + link signer. The tool-side
 * gate lives with each connector (see `src/connectors/unipile/lib/approval-gate.ts`);
 * the same records can later be rendered by an MCP App.
 *
 * Record lifecycle:  pending ──approve──▶ approved ──consume──▶ consumed
 *                       └─────reject (deleted)──┘
 * Consumption is guarded by a separate SETNX marker so two concurrent
 * executions of the same approved preview cannot both win.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig } from "./config-facade";
import { getContextKVStore, getCurrentTenantId } from "./request-context";
import { getSigningSecret } from "./signing-secret";

export type ApprovalMode = "link" | "confirm";

/** Lifetime of a preview, approved or not. */
export const APPROVAL_TTL_SECONDS = 15 * 60;

/** Domain separation: an approval signature can never validate another HMAC use. */
const SIGNATURE_DOMAIN = "kebab-approval-link:v1";

const KEY_PREFIX = "approvals:";
const CONSUMED_PREFIX = "approvals:consumed:";

const ID_RE = /^[a-f0-9]{32}$/;
const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * `KEBAB_APPROVAL_MODE`: `link` (default) requires out-of-band approval;
 * `confirm` restores the pre-phase-1 behaviour (the model's `confirm: true`
 * is enough). Any other value falls back to the safe default.
 */
export function getApprovalMode(): ApprovalMode {
  const raw = getConfig("KEBAB_APPROVAL_MODE")?.trim().toLowerCase();
  return raw === "confirm" ? "confirm" : "link";
}

/** What the user is shown before approving. */
export interface ApprovalSummary {
  /** Account the action is sent from (provider account id). */
  account: string | null;
  /** Human-readable target: person, chat, phone, post, invitation… */
  recipient: string;
  /** Exact text that will be sent or published, when there is one. */
  text: string | null;
  /** Everything else that matters (channel, subject, attachments, reaction…). */
  details: Record<string, unknown>;
}

export type ApprovalStatus = "pending" | "approved" | "consumed";

export interface ApprovalRecord {
  id: string;
  /** Tool that created the preview; only that tool may consume it. */
  tool: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  consumedAt?: number;
  /** Device label / token id of the MCP caller, for display. */
  requestedBy: string | null;
  summary: ApprovalSummary;
  /** Opaque, tool-defined payload executed once approved. */
  payload: Record<string, unknown>;
}

export function isApprovalId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

function recordKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function remainingTtl(rec: ApprovalRecord): number {
  return Math.max(1, Math.ceil((rec.expiresAt - Date.now()) / 1000));
}

function parseRecord(raw: string | null): ApprovalRecord | null {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as ApprovalRecord;
    if (!rec || typeof rec !== "object" || !isApprovalId(rec.id)) return null;
    return rec;
  } catch {
    return null;
  }
}

// ── link signing ─────────────────────────────────────────────────────

function signatureFor(secret: string, id: string, tenantId: string | null): string {
  return createHmac("sha256", secret)
    .update(`${SIGNATURE_DOMAIN}\n${tenantId ?? ""}\n${id}`)
    .digest("hex");
}

export async function signApproval(id: string, tenantId: string | null): Promise<string> {
  return signatureFor(await getSigningSecret(), id, tenantId);
}

export async function verifyApprovalSignature(
  id: string,
  tenantId: string | null,
  sig: string | null | undefined
): Promise<boolean> {
  if (!isApprovalId(id) || typeof sig !== "string" || !/^[a-f0-9]{64}$/.test(sig)) return false;
  if (tenantId !== null && !TENANT_RE.test(tenantId)) return false;
  let expected: string;
  try {
    expected = signatureFor(await getSigningSecret(), id, tenantId);
  } catch {
    return false;
  }
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
}

/**
 * Public origin used to build absolute approval links. Tool handlers do not
 * see the HTTP request, so the origin comes from configuration:
 * `KEBAB_PUBLIC_URL` → Vercel production domain → Vercel deployment URL →
 * `http://localhost:<PORT|3000>`.
 */
export function getPublicOrigin(): string {
  const explicit = getConfig("KEBAB_PUBLIC_URL")?.trim();
  if (explicit) {
    try {
      return new URL(explicit).origin;
    } catch {
      // fall through to platform defaults
    }
  }
  const prod = getConfig("VERCEL_PROJECT_PRODUCTION_URL")?.trim();
  if (prod && getConfig("VERCEL_ENV") === "production") return `https://${prod}`;
  const vercelUrl = getConfig("VERCEL_URL")?.trim();
  if (vercelUrl) return `https://${vercelUrl}`;
  return `http://localhost:${getConfig("PORT")?.trim() || "3000"}`;
}

/** Absolute, signed approval link for a preview of the current tenant. */
export async function buildApprovalUrl(
  id: string,
  tenantId: string | null = getCurrentTenantId()
): Promise<string> {
  const sig = await signApproval(id, tenantId);
  const url = new URL(`/approve/${id}`, getPublicOrigin());
  url.searchParams.set("sig", sig);
  if (tenantId) url.searchParams.set("t", tenantId);
  return url.toString();
}

// ── store ────────────────────────────────────────────────────────────

export async function createPreview(input: {
  tool: string;
  summary: ApprovalSummary;
  payload: Record<string, unknown>;
  requestedBy?: string | null;
  ttlSeconds?: number;
}): Promise<ApprovalRecord> {
  const now = Date.now();
  const ttl = input.ttlSeconds ?? APPROVAL_TTL_SECONDS;
  const rec: ApprovalRecord = {
    id: randomBytes(16).toString("hex"),
    tool: input.tool,
    status: "pending",
    createdAt: now,
    expiresAt: now + ttl * 1000,
    requestedBy: input.requestedBy ?? null,
    summary: input.summary,
    payload: input.payload,
  };
  await getContextKVStore().set(recordKey(rec.id), JSON.stringify(rec), ttl);
  return rec;
}

/**
 * Read a preview. Expired records read as `null` (the filesystem KV used in
 * dev ignores TTLs, so expiry is always checked explicitly).
 */
export async function getPreview(id: string): Promise<ApprovalRecord | null> {
  if (!isApprovalId(id)) return null;
  const rec = parseRecord(await getContextKVStore().get(recordKey(id)));
  if (!rec) return null;
  if (rec.expiresAt <= Date.now()) return null;
  return rec;
}

export type DecideResult =
  | { ok: true; record: ApprovalRecord | null }
  | { ok: false; reason: "not_found" | "already_consumed" };

/**
 * Record the user's decision. `approve` marks a pending preview approved
 * (idempotent); `reject` deletes it. A consumed preview cannot be changed.
 */
export async function decide(id: string, decision: "approve" | "reject"): Promise<DecideResult> {
  const rec = await getPreview(id);
  if (!rec) return { ok: false, reason: "not_found" };
  if (rec.status === "consumed") return { ok: false, reason: "already_consumed" };
  const kv = getContextKVStore();
  if (decision === "reject") {
    await kv.delete(recordKey(id));
    return { ok: true, record: null };
  }
  if (rec.status === "approved") return { ok: true, record: rec };
  const next: ApprovalRecord = { ...rec, status: "approved", decidedAt: Date.now() };
  await kv.set(recordKey(id), JSON.stringify(next), remainingTtl(next));
  return { ok: true, record: next };
}

export type ConsumeResult =
  | { ok: true; record: ApprovalRecord }
  | {
      ok: false;
      reason: "not_found" | "tool_mismatch" | "pending" | "already_consumed";
      record?: ApprovalRecord;
    };

/**
 * Atomically take an approved preview for execution. Single use: the first
 * caller wins the SETNX marker, every later call gets `already_consumed`.
 */
export async function consume(id: string, tool: string): Promise<ConsumeResult> {
  const rec = await getPreview(id);
  if (!rec) return { ok: false, reason: "not_found" };
  if (rec.tool !== tool) return { ok: false, reason: "tool_mismatch" };
  if (rec.status === "consumed") return { ok: false, reason: "already_consumed", record: rec };
  if (rec.status !== "approved") return { ok: false, reason: "pending", record: rec };

  const kv = getContextKVStore();
  const marker = `${CONSUMED_PREFIX}${id}`;
  const value = JSON.stringify({ at: Date.now() });
  const ttlSeconds = remainingTtl(rec) + 60;
  if (typeof kv.setIfNotExists === "function") {
    const res = await kv.setIfNotExists(marker, value, { ttlSeconds });
    if (!res.ok) return { ok: false, reason: "already_consumed", record: rec };
  } else {
    if (await kv.get(marker)) return { ok: false, reason: "already_consumed", record: rec };
    await kv.set(marker, value, ttlSeconds);
  }

  // Re-read: a reject that landed between the first read and the claim wins.
  const fresh = await getPreview(id);
  if (!fresh || fresh.status !== "approved") return { ok: false, reason: "not_found" };
  const consumed: ApprovalRecord = { ...fresh, status: "consumed", consumedAt: Date.now() };
  // Keep only a tombstone (replays read "already used"): the message text
  // does not outlive its execution in KV.
  const tombstone: ApprovalRecord = {
    ...consumed,
    summary: { account: fresh.summary.account, recipient: "", text: null, details: {} },
    payload: {},
  };
  await kv.set(recordKey(id), JSON.stringify(tombstone), remainingTtl(consumed));
  return { ok: true, record: consumed };
}
