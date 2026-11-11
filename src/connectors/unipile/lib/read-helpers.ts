/**
 * Shared helpers for the read-only Unipile inbox tools (linkedin/whatsapp
 * list_inbox + read_messages, and linkedin_list_pending).
 *
 * Two exports:
 *  - `paginateChats` — chat listing shared by linkedin_list_inbox +
 *    whatsapp_list_inbox. Since ADR 0002 the cursor loop (MAX_PAGES cap,
 *    late-page tolerance) lives in the provider adapter; this helper only
 *    re-shapes provider chats into the legacy `RawChat` shape.
 *  - `runRead` — wraps a read-tool handler body so ANY throw (account-resolver
 *    failure, getUnipileClient() on missing env, a stray SDK error) is converted
 *    into the standard `{error}` envelope instead of crashing the MCP request
 *    (review HIGH-2). Read tools never mutate, so a blanket catch is safe — there
 *    is no half-committed state to worry about.
 */

import type { ToolResult } from "@/core/types";
import { getMessagingProvider, type Channel } from "../provider";
import { classifyUnipileError } from "./errors";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";

const log = getLogger("CONNECTOR:unipile");

/** Minimal chat shape the inbox tools consume. SDK returns more fields. */
export interface RawChat {
  id?: string;
  name?: string | null;
  type?: number;
  unread?: number;
  unread_count?: number;
  timestamp?: string;
  folder?: string[];
  provider_id?: string;
  attendee_provider_id?: string;
}

/**
 * Paginate the chats of one account+channel via the messaging provider
 * (ADR 0002) until `limit` items are collected. Native `unread` / `after`
 * filters are forwarded. Re-shaped back to the legacy `RawChat` wire shape so
 * linkedin_list_inbox keeps its locked envelope.
 *
 * The provider returns what it gathered on a late-page failure and throws
 * only on a first-page failure — which the caller's `runRead` converts into
 * an `{error}` envelope.
 */
export async function paginateChats(
  accountId: string,
  accountType: Channel,
  opts: { limit: number; unread?: boolean; afterIso?: string }
): Promise<RawChat[]> {
  const chats = await getMessagingProvider().listChats({
    accountId,
    channel: accountType,
    limit: opts.limit,
    ...(opts.unread ? { unreadOnly: true } : {}),
    ...(opts.afterIso ? { afterIso: opts.afterIso } : {}),
  });
  return chats.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.conversationType === "group" ? 1 : c.conversationType === "channel" ? 2 : 0,
    unread_count: c.unreadCount,
    ...(c.lastMessageAt ? { timestamp: c.lastMessageAt } : {}),
    folder: c.folder,
    ...(c.providerId ? { provider_id: c.providerId } : {}),
    ...(c.attendeeProviderId ? { attendee_provider_id: c.attendeeProviderId } : {}),
  }));
}

/**
 * Run a read-tool handler body, converting any thrown error into the standard
 * empty `{error}` envelope. `emptyEnvelope` is the tool's zero-result shape
 * (count:0/items:[] plus any tool-specific nulls like chat_id), to which the
 * `error` string is added. Safe for read tools only (no mutation to roll back).
 */
export async function runRead<E extends Record<string, unknown>>(
  toolName: string,
  emptyEnvelope: E,
  body: () => Promise<ToolResult>
): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    log.warn(`${toolName} failed`, { err: toMsg(err) });
    const payload = { ...emptyEnvelope, error: classifyUnipileError(err) };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  }
}
