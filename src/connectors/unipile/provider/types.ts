/**
 * Messaging provider interface (ADR 0002).
 *
 * Normalized, SDK-free shapes consumed by the tool layer. Tools never see a
 * vendor payload: an adapter (today `UnipileMessagingProvider`) maps vendor
 * responses onto these types. Swapping vendors = writing one adapter.
 *
 * Conventions:
 *  - Every field a vendor may omit is `| null` (never `undefined`) so JSON
 *    envelopes have a stable shape.
 *  - Timestamps are ISO-8601 strings as returned by the vendor.
 *  - Read methods may retry transient failures internally; send methods must
 *    NOT retry on 5xx (the message may already be delivered).
 */

export type Channel = "LINKEDIN" | "WHATSAPP";

export type ConversationType = "single" | "group" | "channel";

export interface ProviderAccount {
  id: string;
  name: string;
  /** Vendor account type, upper-case (e.g. "LINKEDIN", "WHATSAPP", "GOOGLE"). */
  type: string;
}

export interface ProviderChat {
  id: string;
  /** Owning connected account, when the vendor reports it. */
  accountId: string | null;
  /** Vendor account type of the owning account ("LINKEDIN", "WHATSAPP", …), when known. */
  accountType: string | null;
  name: string | null;
  conversationType: ConversationType;
  /** Vendor-side id of the conversation (e.g. `33612345678@s.whatsapp.net`). */
  providerId: string | null;
  /** Provider id of the other party for 1:1 chats, when known. */
  attendeeProviderId: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  folder: string[];
}

export interface ProviderMessage {
  id: string;
  chatId: string | null;
  direction: "in" | "out";
  senderId: string | null;
  text: string | null;
  sentAt: string | null;
  hasAttachments: boolean;
}

export interface ProviderContact {
  id: string;
  name: string | null;
  providerId: string | null;
  isSelf: boolean;
  profileUrl: string | null;
}

export type Attachment = [filename: string, content: Buffer];

export interface ListChatsQuery {
  accountId: string;
  channel: Channel;
  limit: number;
  unreadOnly?: boolean;
  afterIso?: string;
}

export interface ListMessagesQuery {
  limit: number;
  afterIso?: string;
  beforeIso?: string;
}

/** Channel-agnostic chat / message surface (LinkedIn + WhatsApp). */
export interface MessagingProvider {
  readonly id: string;
  listAccounts(): Promise<ProviderAccount[]>;
  /** Paginates up to `limit`. Returns what it gathered if a late page fails; throws on first-page failure. */
  listChats(q: ListChatsQuery): Promise<ProviderChat[]>;
  /** null when the chat does not exist. */
  getChat(chatId: string): Promise<ProviderChat | null>;
  listChatMessages(q: ListMessagesQuery & { chatId: string }): Promise<ProviderMessage[]>;
  listAccountMessages(q: ListMessagesQuery & { accountId: string }): Promise<ProviderMessage[]>;
  listContacts(q: { accountId: string; limit: number }): Promise<ProviderContact[]>;
  sendToChat(q: {
    chatId: string;
    text: string;
    attachments?: Attachment[];
  }): Promise<{ messageId: string | null }>;
  startChat(q: {
    accountId: string;
    recipientIds: string[];
    text: string;
    attachments?: Attachment[];
  }): Promise<{ chatId: string | null; messageId: string | null }>;
}

// ── LinkedIn network surface ──────────────────────────────────────────────

export interface LinkedinPosition {
  title: string | null;
  company: string | null;
  start: string | null;
  end: string | null;
}

export interface LinkedinProfile {
  kind: "person";
  providerId: string | null;
  publicIdentifier: string | null;
  profileUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  location: string | null;
  summary: string | null;
  degree: 1 | 2 | 3 | null;
  connectionsCount: number | null;
  followersCount: number | null;
  isPremium: boolean | null;
  isOpenProfile: boolean | null;
  positions: LinkedinPosition[];
}

export interface LinkedinCompany {
  kind: "company";
  id: string | null;
  name: string | null;
  publicIdentifier: string | null;
  profileUrl: string | null;
  tagline: string | null;
  description: string | null;
  industry: string | null;
  employeeCount: number | null;
  followersCount: number | null;
  website: string | null;
}

export interface LinkedinConnection {
  providerId: string | null;
  publicIdentifier: string | null;
  profileUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  connectedAt: string | null;
}

export interface LinkedinPost {
  postId: string | null;
  text: string | null;
  date: string | null;
  url: string | null;
  authorName: string | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  isRepost: boolean;
}

export interface LinkedinSearchResult {
  type: "person" | "company" | "other";
  name: string | null;
  headline: string | null;
  location: string | null;
  providerId: string | null;
  publicIdentifier: string | null;
  profileUrl: string | null;
  degree: 1 | 2 | 3 | null;
}

export type LinkedinReaction = "like" | "celebrate" | "support" | "love" | "insightful" | "funny";

export interface LinkedinNetworkProvider {
  getProfile(q: { accountId: string; identifier: string }): Promise<LinkedinProfile>;
  getCompany(q: { accountId: string; identifier: string }): Promise<LinkedinCompany>;
  listConnections(q: { accountId: string; limit: number }): Promise<LinkedinConnection[]>;
  search(q: {
    accountId: string;
    category: "people" | "companies";
    keywords?: string;
    url?: string;
    limit: number;
  }): Promise<LinkedinSearchResult[]>;
  listPosts(q: {
    accountId: string;
    identifier: string;
    isCompany: boolean;
    limit: number;
  }): Promise<LinkedinPost[]>;
  /** Resolve a post id / urn / URL to the vendor id accepted by comment + react. */
  resolvePostId(q: { accountId: string; post: string }): Promise<string>;
  createPost(q: { accountId: string; text: string }): Promise<{ postId: string | null }>;
  commentPost(q: { accountId: string; postId: string; text: string }): Promise<void>;
  reactPost(q: { accountId: string; postId: string; reaction: LinkedinReaction }): Promise<void>;
  cancelInvitation(q: { accountId: string; invitationId: string }): Promise<void>;
}

export type FullProvider = MessagingProvider & LinkedinNetworkProvider;
