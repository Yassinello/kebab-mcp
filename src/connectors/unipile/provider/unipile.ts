/**
 * Unipile adapter for the messaging provider interface (ADR 0002).
 *
 * The ONLY module of the provider surface that touches `unipile-node-sdk`.
 * Responsibilities:
 *  - map SDK payloads onto the normalized `provider/types.ts` shapes
 *    (defensive: every field is optional on the wire);
 *  - retry transient failures on reads (`withRetry`, 429/502/503/504);
 *  - retry sends ONLY on 429 (`WRITE_RETRYABLE`) — a 5xx may arrive after the
 *    message was delivered, and a retry would double-send.
 *
 * The client is fetched lazily per call via `getUnipileClient()` so the
 * existing test seam (`vi.mock("../lib/client")`) keeps working for every
 * tool that now routes through the provider.
 */

import { getUnipileClient } from "../lib/client";
import { withRetry, WRITE_RETRYABLE } from "../lib/retry";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
import type {
  Attachment,
  ConversationType,
  FullProvider,
  LinkedinCompany,
  LinkedinConnection,
  LinkedinPost,
  LinkedinProfile,
  LinkedinReaction,
  LinkedinSearchResult,
  ListChatsQuery,
  ListMessagesQuery,
  ProviderAccount,
  ProviderChat,
  ProviderContact,
  ProviderMessage,
} from "./types";

const log = getLogger("CONNECTOR:unipile");

/** Unipile's per-page hard cap on list endpoints. */
const PAGE_CAP = 100;
/** Runaway guard for cursor pagination (PAGE_CAP × MAX_PAGES items max). */
const MAX_PAGES = 10;

// ── small coercion helpers (wire payloads are untyped) ──────────────────

type Raw = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function items(resp: unknown): Raw[] {
  const list = (resp as { items?: unknown } | null)?.items;
  return Array.isArray(list) ? (list.filter((x) => x && typeof x === "object") as Raw[]) : [];
}

function cursorOf(resp: unknown): string | null {
  return str((resp as { cursor?: unknown } | null)?.cursor);
}

/** Map Unipile `network_distance` spellings onto 1/2/3. Unknown → null. */
export function distanceToDegree(distance: unknown): 1 | 2 | 3 | null {
  if (distance === "FIRST_DEGREE" || distance === "DISTANCE_1") return 1;
  if (distance === "SECOND_DEGREE" || distance === "DISTANCE_2") return 2;
  if (distance === "THIRD_DEGREE" || distance === "DISTANCE_3") return 3;
  return null;
}

/** SDK chat `type` enum: SINGLE=0, GROUP=1, CHANNEL=2. */
function conversationType(type: unknown): ConversationType {
  if (type === 1) return "group";
  if (type === 2) return "channel";
  return "single";
}

export function mapChat(c: Raw): ProviderChat | null {
  const id = str(c.id);
  if (!id) return null;
  const unread = num(c.unread_count) ?? num(c.unread) ?? 0;
  return {
    id,
    accountId: str(c.account_id),
    accountType: str(c.account_type),
    name: str(c.name),
    conversationType: conversationType(c.type),
    providerId: str(c.provider_id),
    attendeeProviderId: str(c.attendee_provider_id),
    unreadCount: unread,
    lastMessageAt: str(c.timestamp),
    folder: Array.isArray(c.folder)
      ? c.folder.filter((f): f is string => typeof f === "string")
      : [],
  };
}

export function mapMessage(m: Raw): ProviderMessage | null {
  const id = str(m.id);
  if (!id) return null;
  return {
    id,
    chatId: str(m.chat_id),
    direction: m.is_sender === 1 || m.is_sender === true ? "out" : "in",
    senderId: str(m.sender_id),
    text: typeof m.text === "string" ? m.text : null,
    sentAt: str(m.timestamp),
    hasAttachments: Array.isArray(m.attachments) && m.attachments.length > 0,
  };
}

function mapContact(a: Raw): ProviderContact | null {
  const id = str(a.id);
  if (!id) return null;
  return {
    id,
    name: str(a.name),
    providerId: str(a.provider_id),
    isSelf: a.is_self === 1 || a.is_self === true,
    profileUrl: str(a.profile_url),
  };
}

/**
 * Generic cursor paginator. `fetchPage(cursor, pageLimit)` returns the raw
 * page. On a late-page failure the items gathered so far are returned; a
 * first-page failure is re-thrown so the caller can surface an error.
 */
async function paginate(
  label: string,
  limit: number,
  fetchPage: (cursor: string | null, pageLimit: number) => Promise<unknown>
): Promise<Raw[]> {
  const all: Raw[] = [];
  let cursor: string | null = null;
  let pages = 0;
  try {
    do {
      const pageLimit = Math.min(limit - all.length, PAGE_CAP);
      if (pageLimit <= 0) break;
      const resp = await withRetry(() => fetchPage(cursor, pageLimit));
      all.push(...items(resp));
      cursor = cursorOf(resp);
      pages += 1;
      if (pages >= MAX_PAGES) {
        log.warn(`${label}: hit MAX_PAGES safety cap`, { pages, collected: all.length });
        break;
      }
    } while (cursor && all.length < limit);
  } catch (err) {
    log.warn(`${label}: page fetch failed`, { collected: all.length, err: toMsg(err) });
    if (all.length === 0) throw err;
  }
  return all.slice(0, limit);
}

// ── LinkedIn identifier helpers ─────────────────────────────────────────

/**
 * Extract the identifier Unipile's `/users/{identifier}` accepts from a
 * profile URL, public identifier or provider id. URL → `/in/<slug>` segment.
 */
export function profileIdentifier(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (m?.[1]) return decodeURIComponent(m[1]);
  return trimmed.replace(/\/+$/, "");
}

/** `/company/<slug>` (or `/school/<slug>`) segment of a company URL, else the input. */
export function companyIdentifier(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/i);
  if (m?.[1]) return decodeURIComponent(m[1]);
  return trimmed.replace(/\/+$/, "");
}

export function isCompanyUrl(input: string): boolean {
  return /linkedin\.com\/(?:company|school|showcase)\//i.test(input);
}

/**
 * Normalize a post reference to a Unipile post id. Accepts a urn
 * (`urn:li:activity:123`, `urn:li:ugcPost:123`, `urn:li:share:123`), a bare
 * numeric activity id, or a post URL containing `activity-<id>` /
 * `urn:li:activity:<id>` (also URL-encoded). Returns null when nothing matches.
 */
export function parsePostReference(input: string): string | null {
  const s = decodeURIComponent(input.trim());
  const urn = s.match(/urn:li:(activity|ugcPost|share):(\d{6,})/);
  if (urn) return `urn:li:${urn[1]}:${urn[2]}`;
  const act = s.match(/activity[-:](\d{6,})/);
  if (act) return `urn:li:activity:${act[1]}`;
  if (/^\d{6,}$/.test(s)) return `urn:li:activity:${s}`;
  return null;
}

function mapProfile(p: Raw): LinkedinProfile {
  const exp = Array.isArray(p.work_experience) ? (p.work_experience as Raw[]) : [];
  const positions = exp
    .filter((e) => e && typeof e === "object")
    .slice(0, 5)
    .map((e) => ({
      title: str(e.position),
      company: str(e.company),
      start: str(e.start),
      end: str(e.end),
    }));
  return {
    kind: "person",
    providerId: str(p.provider_id),
    publicIdentifier: str(p.public_identifier),
    profileUrl:
      str(p.public_profile_url) ??
      (str(p.public_identifier)
        ? `https://www.linkedin.com/in/${String(p.public_identifier)}`
        : null),
    firstName: str(p.first_name),
    lastName: str(p.last_name),
    headline: str(p.headline),
    location: str(p.location),
    summary: str(p.summary),
    degree: distanceToDegree(p.network_distance),
    connectionsCount: num(p.connections_count),
    followersCount: num(p.follower_count) ?? num(p.followers_count),
    isPremium: bool(p.is_premium),
    isOpenProfile: bool(p.is_open_profile),
    positions,
  };
}

function mapCompany(c: Raw): LinkedinCompany {
  const employees = c.employee_count;
  return {
    kind: "company",
    id: str(c.id),
    name: str(c.name),
    publicIdentifier: str(c.public_identifier),
    profileUrl: str(c.profile_url),
    tagline: str(c.tagline),
    description: str(c.description),
    industry: Array.isArray(c.industry)
      ? (c.industry as unknown[]).filter((x): x is string => typeof x === "string").join(", ") ||
        null
      : str(c.industry),
    employeeCount: num(employees),
    followersCount: num(c.followers_count),
    website: str(c.website),
  };
}

function mapConnection(r: Raw): LinkedinConnection {
  return {
    providerId: str(r.member_id),
    publicIdentifier: str(r.public_identifier),
    profileUrl: str(r.public_profile_url),
    firstName: str(r.first_name),
    lastName: str(r.last_name),
    headline: str(r.headline),
    connectedAt:
      typeof r.created_at === "number" ? new Date(r.created_at).toISOString() : str(r.created_at),
  };
}

function mapPost(p: Raw): LinkedinPost {
  const author = (p.author && typeof p.author === "object" ? p.author : {}) as Raw;
  return {
    postId: str(p.social_id) ?? str(p.id),
    text: typeof p.text === "string" ? p.text : null,
    date: str(p.parsed_datetime) ?? str(p.date),
    url: str(p.share_url),
    authorName: str(author.name),
    reactions: num(p.reaction_counter),
    comments: num(p.comment_counter),
    reposts: num(p.repost_counter),
    isRepost: p.is_repost === true,
  };
}

function mapSearchItem(i: Raw): LinkedinSearchResult {
  const t = String(i.type ?? "").toUpperCase();
  const type: LinkedinSearchResult["type"] =
    t === "PEOPLE" || t === "PERSON" ? "person" : t === "COMPANY" ? "company" : "other";
  return {
    type,
    name: str(i.name),
    headline: str(i.headline) ?? str(i.summary),
    location: str(i.location),
    providerId: str(i.id),
    publicIdentifier: str(i.public_identifier),
    profileUrl: str(i.public_profile_url) ?? str(i.profile_url),
    degree: distanceToDegree(i.network_distance),
  };
}

/** Minimal typing of the SDK's raw-request escape hatch (`client.request.send`). */
interface RawRequestClient {
  request: {
    send: (i: {
      method: "GET" | "POST";
      path: string[];
      parameters?: Record<string, string>;
      body?: Record<string, unknown>;
      headers?: { "Content-Type": "application/json" };
    }) => Promise<unknown>;
  };
}

// ── adapter ─────────────────────────────────────────────────────────────

export class UnipileMessagingProvider implements FullProvider {
  readonly id = "unipile";

  async listAccounts(): Promise<ProviderAccount[]> {
    const resp = await withRetry(() => getUnipileClient().account.getAll());
    return items(resp)
      .filter((a) => str(a.id) && str(a.type))
      .map((a) => ({ id: String(a.id), name: str(a.name) ?? String(a.id), type: String(a.type) }));
  }

  async listChats(q: ListChatsQuery): Promise<ProviderChat[]> {
    const raw = await paginate("listChats", q.limit, (cursor, pageLimit) =>
      getUnipileClient().messaging.getAllChats({
        account_id: q.accountId,
        account_type: q.channel,
        limit: pageLimit,
        ...(q.unreadOnly ? { unread: true } : {}),
        ...(q.afterIso ? { after: q.afterIso } : {}),
        ...(cursor ? { cursor } : {}),
      })
    );
    return raw.map(mapChat).filter((c): c is ProviderChat => c !== null);
  }

  async getChat(chatId: string): Promise<ProviderChat | null> {
    try {
      const resp = await withRetry(() => getUnipileClient().messaging.getChat(chatId));
      return mapChat(resp as unknown as Raw);
    } catch (err) {
      const status = (err as { body?: { status?: number } }).body?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  async listChatMessages(q: ListMessagesQuery & { chatId: string }): Promise<ProviderMessage[]> {
    const raw = await paginate("listChatMessages", q.limit, (cursor, pageLimit) =>
      getUnipileClient().messaging.getAllMessagesFromChat({
        chat_id: q.chatId,
        limit: pageLimit,
        ...(q.afterIso ? { after: q.afterIso } : {}),
        ...(q.beforeIso ? { before: q.beforeIso } : {}),
        ...(cursor ? { cursor } : {}),
      })
    );
    return raw.map(mapMessage).filter((m): m is ProviderMessage => m !== null);
  }

  async listAccountMessages(
    q: ListMessagesQuery & { accountId: string }
  ): Promise<ProviderMessage[]> {
    const raw = await paginate("listAccountMessages", q.limit, (cursor, pageLimit) =>
      getUnipileClient().messaging.getAllMessages({
        account_id: q.accountId,
        limit: pageLimit,
        ...(q.afterIso ? { after: q.afterIso } : {}),
        ...(q.beforeIso ? { before: q.beforeIso } : {}),
        ...(cursor ? { cursor } : {}),
      })
    );
    return raw.map(mapMessage).filter((m): m is ProviderMessage => m !== null);
  }

  async listContacts(q: { accountId: string; limit: number }): Promise<ProviderContact[]> {
    const raw = await paginate("listContacts", q.limit, (cursor, pageLimit) =>
      getUnipileClient().messaging.getAllAttendees({
        account_id: q.accountId,
        limit: pageLimit,
        ...(cursor ? { cursor } : {}),
      })
    );
    return raw.map(mapContact).filter((c): c is ProviderContact => c !== null);
  }

  async sendToChat(q: {
    chatId: string;
    text: string;
    attachments?: Attachment[];
  }): Promise<{ messageId: string | null }> {
    const resp = await withRetry(
      () =>
        getUnipileClient().messaging.sendMessage({
          chat_id: q.chatId,
          text: q.text,
          ...(q.attachments?.length ? { attachments: q.attachments } : {}),
        }),
      { statuses: WRITE_RETRYABLE }
    );
    return { messageId: str((resp as { message_id?: unknown }).message_id) };
  }

  async startChat(q: {
    accountId: string;
    recipientIds: string[];
    text: string;
    attachments?: Attachment[];
  }): Promise<{ chatId: string | null; messageId: string | null }> {
    const resp = await withRetry(
      () =>
        getUnipileClient().messaging.startNewChat({
          account_id: q.accountId,
          attendees_ids: q.recipientIds,
          text: q.text,
          ...(q.attachments?.length ? { attachments: q.attachments } : {}),
        }),
      { statuses: WRITE_RETRYABLE }
    );
    const r = resp as { chat_id?: unknown; message_id?: unknown };
    return { chatId: str(r.chat_id), messageId: str(r.message_id) };
  }

  // ── LinkedIn network ──

  async getProfile(q: { accountId: string; identifier: string }): Promise<LinkedinProfile> {
    const resp = await withRetry(() =>
      getUnipileClient().users.getProfile({
        account_id: q.accountId,
        identifier: profileIdentifier(q.identifier),
        linkedin_sections: ["experience", "about"],
      })
    );
    return mapProfile(resp as unknown as Raw);
  }

  async getCompany(q: { accountId: string; identifier: string }): Promise<LinkedinCompany> {
    const resp = await withRetry(() =>
      getUnipileClient().users.getCompanyProfile({
        account_id: q.accountId,
        identifier: companyIdentifier(q.identifier),
      })
    );
    return mapCompany(resp as unknown as Raw);
  }

  async listConnections(q: { accountId: string; limit: number }): Promise<LinkedinConnection[]> {
    const raw = await paginate("listConnections", q.limit, (cursor, pageLimit) =>
      getUnipileClient().users.getAllRelations({
        account_id: q.accountId,
        limit: pageLimit,
        ...(cursor ? { cursor } : {}),
      })
    );
    return raw.map(mapConnection);
  }

  async search(q: {
    accountId: string;
    category: "people" | "companies";
    keywords?: string;
    url?: string;
    limit: number;
  }): Promise<LinkedinSearchResult[]> {
    const client = getUnipileClient() as unknown as RawRequestClient;
    const body: Record<string, unknown> = q.url
      ? { url: q.url }
      : { api: "classic", category: q.category, keywords: q.keywords ?? "" };
    const resp = await withRetry(() =>
      client.request.send({
        method: "POST",
        path: ["linkedin", "search"],
        parameters: { account_id: q.accountId, limit: String(Math.min(q.limit, 50)) },
        body,
        headers: { "Content-Type": "application/json" },
      })
    );
    return items(resp).slice(0, q.limit).map(mapSearchItem);
  }

  async listPosts(q: {
    accountId: string;
    identifier: string;
    isCompany: boolean;
    limit: number;
  }): Promise<LinkedinPost[]> {
    let identifier: string;
    if (q.isCompany) {
      // Company posts are keyed by the company's numeric id, not its slug.
      const company = await this.getCompany({ accountId: q.accountId, identifier: q.identifier });
      identifier = company.id ?? companyIdentifier(q.identifier);
    } else {
      // Person posts are keyed by provider id; resolve the slug first.
      const profile = await this.getProfile({ accountId: q.accountId, identifier: q.identifier });
      identifier = profile.providerId ?? profileIdentifier(q.identifier);
    }
    const raw = await paginate("listPosts", q.limit, (cursor, pageLimit) =>
      getUnipileClient().users.getAllPosts({
        account_id: q.accountId,
        identifier,
        limit: pageLimit,
        is_company: q.isCompany,
        ...(cursor ? { cursor } : {}),
      })
    );
    return raw.map(mapPost);
  }

  async resolvePostId(q: { accountId: string; post: string }): Promise<string> {
    const ref = parsePostReference(q.post) ?? q.post.trim();
    // Unipile's comment/react endpoints want the post's `social_id`; getPost
    // resolves any accepted id form to it.
    const resp = await withRetry(() =>
      getUnipileClient().users.getPost({ account_id: q.accountId, post_id: ref })
    );
    return str((resp as { social_id?: unknown }).social_id) ?? ref;
  }

  async createPost(q: { accountId: string; text: string }): Promise<{ postId: string | null }> {
    const resp = await withRetry(
      () => getUnipileClient().users.createPost({ account_id: q.accountId, text: q.text }),
      { statuses: WRITE_RETRYABLE }
    );
    const r = resp as { post_id?: unknown; social_id?: unknown };
    return { postId: str(r.post_id) ?? str(r.social_id) };
  }

  async commentPost(q: { accountId: string; postId: string; text: string }): Promise<void> {
    await withRetry(
      () =>
        getUnipileClient().users.sendPostComment({
          account_id: q.accountId,
          post_id: q.postId,
          text: q.text,
        }),
      { statuses: WRITE_RETRYABLE }
    );
  }

  async reactPost(q: {
    accountId: string;
    postId: string;
    reaction: LinkedinReaction;
  }): Promise<void> {
    // Reactions are idempotent upstream (re-reacting replaces) — default retry set is safe.
    await withRetry(() =>
      getUnipileClient().users.sendPostReaction({
        account_id: q.accountId,
        post_id: q.postId,
        reaction_type: q.reaction,
      })
    );
  }

  async cancelInvitation(q: { accountId: string; invitationId: string }): Promise<void> {
    await withRetry(() =>
      getUnipileClient().users.cancelInvitationSent({
        account_id: q.accountId,
        invitation_id: q.invitationId,
      })
    );
  }
}
