import { UnipileClient } from "unipile-node-sdk";
import { defineTool, type ConnectorManifest, type ToolDefinition } from "@/core/types";
import { getConfig } from "@/core/config-facade";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
import { isWritesDisabled, isWhatsappWritesDisabled } from "./lib/kill-switch";
import { approvalHint, gateGuardedWrite, gateLegacyWrite } from "./lib/approval-gate";
import {
  engageApproval,
  sendConnectionApproval,
  sendInmailApproval,
  sendMessageApproval,
} from "./lib/legacy-approvals";

function normalizeDsnForProbe(dsn: string): string {
  return /^https?:\/\//i.test(dsn) ? dsn : `https://${dsn}`;
}
import {
  linkedinSendConnectionSchema,
  handleLinkedinSendConnection,
} from "./tools/linkedin-send-connection";
import {
  linkedinGetRelationshipStatusSchema,
  handleLinkedinGetRelationshipStatus,
} from "./tools/linkedin-get-relationship-status";
import {
  linkedinSendMessageSchema,
  handleLinkedinSendMessage,
} from "./tools/linkedin-send-message";
import { linkedinSendInmailSchema, handleLinkedinSendInmail } from "./tools/linkedin-send-inmail";
import { linkedinEngageSchema, handleLinkedinEngage } from "./tools/linkedin-engage";
import {
  linkedinListPendingSchema,
  handleLinkedinListPending,
} from "./tools/linkedin-list-pending";
import { linkedinListInboxSchema, handleLinkedinListInbox } from "./tools/linkedin-list-inbox";
import {
  linkedinReadMessagesSchema,
  handleLinkedinReadMessages,
} from "./tools/linkedin-read-messages";
import { whatsappListInboxSchema, handleWhatsappListInbox } from "./tools/whatsapp-list-inbox";
import {
  whatsappReadMessagesSchema,
  handleWhatsappReadMessages,
} from "./tools/whatsapp-read-messages";
import { whatsappFindChatSchema, handleWhatsappFindChat } from "./tools/whatsapp-find-chat";
import {
  whatsappSearchMessagesSchema,
  linkedinSearchMessagesSchema,
  handleWhatsappSearchMessages,
  handleLinkedinSearchMessages,
} from "./tools/search-messages";
import {
  whatsappSendMessageSchema,
  linkedinReplySchema,
  handleWhatsappSendMessage,
  handleLinkedinReply,
} from "./tools/messaging-send";
import {
  linkedinGetProfileSchema,
  linkedinListConnectionsSchema,
  linkedinSearchSchema,
  linkedinListPostsSchema,
  linkedinReactPostSchema,
  linkedinCommentPostSchema,
  linkedinCreatePostSchema,
  linkedinCancelInvitationSchema,
  handleLinkedinGetProfile,
  handleLinkedinListConnections,
  handleLinkedinSearch,
  handleLinkedinListPosts,
  handleLinkedinReactPost,
  handleLinkedinCommentPost,
  handleLinkedinCreatePost,
  handleLinkedinCancelInvitation,
} from "./tools/linkedin-network";

const log = getLogger("CONNECTOR:unipile");

/**
 * Phase 68/69 — manifest with all 6 LinkedIn tools wired (UNI-07..10 closes
 * the phase 69 surface; phase 68 Plan 06 originally shipped 2 tools).
 *
 * Phase 68 (locked, do not reorder):
 *  - `linkedin_send_connection` (destructive WRITE) — verify-after-write,
 *    D-13/D-14/D-15/D-20 envelope locked. Phase 69 Plan 06 added a
 *    per-account / per-tool rate-limit check (D-43 + D-49) between
 *    account-resolve and provider-resolve — fully backwards compatible.
 *  - `linkedin_get_relationship_status` (read) — D-21 envelope
 *    {degree, connection_status}.
 *
 * Phase 69 (4 new tools — Wave 2/3 shipped in plans 03/04/05/06):
 *  - `linkedin_send_message` (destructive WRITE) — 1st-degree DM with
 *    attachments + verify-after-write polling (D-22/D-46/D-47).
 *  - `linkedin_send_inmail` (destructive WRITE) — paid InMail with credit
 *    bracketing + Premium gate + allow_inmail: literal(true) safety belt
 *    (D-26/D-27/D-28/D-29/D-48/D-50).
 *  - `linkedin_engage` (destructive WRITE — super-tool) — degree-routed
 *    dispatcher with dry_run preview (D-30/D-31/D-32/D-33).
 *  - `linkedin_list_pending` (read) — pending invitations cleanup helper
 *    with age_days + has_note (D-34/D-35/D-36/D-37).
 *
 * Tools are exposed via a lazy `get tools()` getter (mirrors
 * apify/manifest.ts) so any future env-driven filtering (e.g. an
 * `UNIPILE_TOOLS` allowlist akin to `APIFY_ACTORS`) can read process.env
 * at resolve time rather than module load.
 *
 * Decision references:
 *  - D-19 (CONTEXT.md): testConnection uses client.account.getAll() and
 *    requires ≥1 LinkedIn account. Silent "active but unusable" connectors
 *    mislead operators — we fail loud when no LinkedIn account is wired.
 *  - T-68-01-01 (threat model): never log the DSN or token value; log
 *    only the outcome string (e.g. "Connected — 2 LinkedIn account(s)").
 */

interface UnipileAccountItem {
  id?: string;
  name?: string;
  type?: string;
  // SDK exposes additional fields (status, created_at, etc.) — only id/name/
  // type are load-bearing here; the rest are intentionally unmodeled.
}

interface UnipileAccountListResponse {
  items?: UnipileAccountItem[];
}

function countAccounts(resp: UnipileAccountListResponse, type: string): number {
  const items = resp.items ?? [];
  return items.filter((it) => it?.type === type).length;
}

/**
 * Phase 72 (D-72): project the connected accounts into the minimal
 * {id, name, type} shape the /config default-account picker consumes. Only
 * messaging types Kebab tools can act on are surfaced (LinkedIn + WhatsApp);
 * mail/calendar/etc. accounts on the same Unipile token are irrelevant to the
 * picker and omitted. Items missing an id are dropped (an id-less account can
 * never be pinned). NEVER includes credentials — only the provider's own
 * public id + display name (T-68-01-01).
 */
const PICKER_ACCOUNT_TYPES = new Set(["LINKEDIN", "WHATSAPP"]);

function pickerAccounts(
  resp: UnipileAccountListResponse
): Array<{ id: string; name: string; type: string }> {
  const items = resp.items ?? [];
  return items
    .filter((it) => it?.type && PICKER_ACCOUNT_TYPES.has(it.type) && it.id)
    .map((it) => ({ id: it.id!, name: it.name ?? it.id!, type: it.type! }));
}

async function probe(
  dsn: string,
  token: string
): Promise<{
  ok: boolean;
  message: string;
  detail?: string;
  // Phase 71 / Plan 71-01 (D-88) — global kill-switch surface for the
  // /config → Connectors tile. Always populated (true | false) so the
  // dashboard can render the warning state without optional-handling.
  writes_disabled?: boolean;
  // Phase 72 (D-72) — connected LinkedIn/WhatsApp accounts for the /config
  // default-account picker. Populated on the success path only.
  accounts?: Array<{ id: string; name: string; type: string }>;
}> {
  const writes_disabled = isWritesDisabled() || isWhatsappWritesDisabled();
  try {
    const client = new UnipileClient(normalizeDsnForProbe(dsn), token);
    const resp = (await client.account.getAll()) as UnipileAccountListResponse;
    const linkedinCount = countAccounts(resp, "LINKEDIN");
    const whatsappCount = countAccounts(resp, "WHATSAPP");
    const total = resp.items?.length ?? 0;
    // Spec v2: a token with only WhatsApp (or only LinkedIn) is healthy — each
    // channel's tools resolve their own account and fail loud if absent.
    if (linkedinCount + whatsappCount >= 1) {
      log.info(
        `Unipile probe ok: ${linkedinCount} LinkedIn + ${whatsappCount} WhatsApp account(s) of ${total} total`
      );
      const summary = `Connected — ${linkedinCount} LinkedIn, ${whatsappCount} WhatsApp account(s)`;
      return {
        ok: true,
        message: writes_disabled ? `${summary} — ⚠ writes disabled` : summary,
        writes_disabled,
        accounts: pickerAccounts(resp),
      };
    }
    log.info(`Unipile probe: no LinkedIn or WhatsApp account connected (${total} total accounts)`);
    return {
      ok: false,
      message: "No LinkedIn or WhatsApp account connected to Unipile token",
      detail: `Total accounts on token: ${total}`,
      writes_disabled,
    };
  } catch (err) {
    const msg = toMsg(err);
    log.info(`Unipile probe failed: ${msg}`);
    return {
      ok: false,
      message: `Unipile: ${msg}`,
      writes_disabled,
    };
  }
}

export const unipileConnector: ConnectorManifest = {
  id: "unipile",
  label: "Unipile (LinkedIn + WhatsApp)",
  description:
    "LinkedIn networking & prospection (invites, DMs, InMail, replies, profiles, search, posts) and personal WhatsApp (find chats, read, search, send to people or groups) via Unipile. Every outgoing action previews first and needs the user's approval (an approval link by default).",
  guide: `Drive your LinkedIn and your personal WhatsApp from any AI client through [Unipile](https://www.unipile.com) — a hosted API that holds the LinkedIn / WhatsApp sessions (no browser automation on Kebab's side).

### Prerequisites
A Unipile account (from 49 €/month for up to 10 connected accounts, all channels) with at least one **LinkedIn** or **WhatsApp** account connected.

### How to get credentials
1. Sign in to the [Unipile dashboard](https://dashboard.unipile.com).
2. **Settings → API**: copy the **DSN** (e.g. \`api41.unipile.com:17153\`) → \`UNIPILE_DSN\`, and the **API token** → \`UNIPILE_TOKEN\`.
3. **Accounts → Add account**: connect LinkedIn (credentials or cookie) and/or WhatsApp (scan the QR code from your phone: WhatsApp → Linked devices).
4. Paste both values in /config → Connectors → Unipile and click **Test**. If the token has several accounts of one type, pick yours in the **Default account** dropdown.

### What you can do
- **WhatsApp**: \`whatsapp_find_chat\` (group/contact by name or phone) → \`whatsapp_read_messages\` / \`whatsapp_search_messages\` → \`whatsapp_send_message\` (to a chat or a phone number).
- **LinkedIn messaging**: \`linkedin_list_inbox\`, \`linkedin_read_messages\`, \`linkedin_search_messages\`, \`linkedin_reply\`, \`linkedin_send_message\`, \`linkedin_send_inmail\`.
- **LinkedIn networking**: \`linkedin_search\`, \`linkedin_get_profile\`, \`linkedin_get_relationship_status\`, \`linkedin_send_connection\`, \`linkedin_engage\`, \`linkedin_list_connections\`, \`linkedin_list_pending\`, \`linkedin_cancel_invitation\`.
- **LinkedIn content**: \`linkedin_list_posts\`, \`linkedin_react_post\`, \`linkedin_comment_post\`, \`linkedin_create_post\`.

### Safety
- Every send/post/invite returns a **preview** first and sends nothing. By default (\`KEBAB_APPROVAL_MODE=link\`) the AI hands you an **approval link**: open it, check the exact recipient and text, approve — only then can the AI send, and only what you approved. \`KEBAB_APPROVAL_MODE=confirm\` restores the older in-chat \`confirm: true\` flow (the AI can then approve on its own).
- Per-account daily caps (LinkedIn: 25 invites, 50 DMs, 15 InMail, 40 reactions/comments, 3 posts; WhatsApp: 100 messages), overridable via \`KEBAB_UNIPILE_*_CAP\`. Identical sends within 10 minutes are blocked.
- Emergency brakes: \`KEBAB_UNIPILE_WRITES_DISABLED=true\` (everything), or per channel \`KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED\` / \`KEBAB_UNIPILE_WHATSAPP_WRITES_DISABLED\`.
- Audit log (90 days, Upstash KV) stores hashes only — never message text.
- Unofficial automation can get accounts restricted by LinkedIn or WhatsApp. Keep volumes human.`,
  requiredEnvVars: ["UNIPILE_DSN", "UNIPILE_TOKEN"],
  testConnection: async (credentials) => {
    const dsn = credentials.UNIPILE_DSN;
    const token = credentials.UNIPILE_TOKEN;
    if (!dsn || !token) {
      return { ok: false, message: "Missing UNIPILE_DSN or UNIPILE_TOKEN" };
    }
    return probe(dsn, token);
  },
  diagnose: async () => {
    const dsn = getConfig("UNIPILE_DSN");
    const token = getConfig("UNIPILE_TOKEN");
    if (!dsn || !token) {
      return { ok: false, message: "UNIPILE_DSN or UNIPILE_TOKEN not set" };
    }
    return probe(dsn, token);
  },
  get tools(): ToolDefinition[] {
    return buildTools();
  },
};

function buildTools(): ToolDefinition[] {
  return [
    defineTool({
      name: "linkedin_send_connection",
      description:
        "Send a LinkedIn connection request via Unipile. Verified-after-write (3 polls @ 2s/5s/10s). " +
        "DEDUP: same (profile_url, note) combination is blocked for 90 days — change the note to retry. " +
        "Per-account daily/weekly caps enforced (25/day, 100/week default). " +
        "Returns {provider_ok, verified, crm_sync: 'pending', dedup_hit, audit_id, invitation_id?, error?, blocked_by_rate_limit?}. " +
        approvalHint({ legacy: true }),
      schema: linkedinSendConnectionSchema,
      handler: async (args) =>
        gateLegacyWrite(sendConnectionApproval, args, (a) =>
          handleLinkedinSendConnection(a as Parameters<typeof handleLinkedinSendConnection>[0])
        ),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_get_relationship_status",
      description:
        "Read the network distance (1/2/3/null) of a LinkedIn profile relative to the connected account. " +
        "Returns {degree: 1|2|3|null, connection_status: string}.",
      schema: linkedinGetRelationshipStatusSchema,
      handler: async (args) =>
        handleLinkedinGetRelationshipStatus(
          args as Parameters<typeof handleLinkedinGetRelationshipStatus>[0]
        ),
      destructive: false,
    }),
    defineTool({
      name: "linkedin_send_message",
      description:
        "Send a LinkedIn DM to a 1st-degree connection. " +
        "Attachments supported (PDF / PNG / JPEG / GIF, ≤15MB per file, ≤5 files). " +
        "Verified-after-write (polls at 5s + 10s). Refuses if recipient is not 1st-degree. " +
        approvalHint({ legacy: true }),
      schema: linkedinSendMessageSchema,
      handler: async (args) =>
        gateLegacyWrite(sendMessageApproval, args, (a) =>
          handleLinkedinSendMessage(a as Parameters<typeof handleLinkedinSendMessage>[0])
        ),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_send_inmail",
      description:
        "Send a LinkedIn InMail (paid). REQUIRES allow_inmail: true to confirm credit usage. " +
        "Tracks credits_used / credits_remaining via inmail_balance bracketing. " +
        "Requires Premium / Sales Navigator / Recruiter subscription. " +
        approvalHint({ legacy: true }),
      schema: linkedinSendInmailSchema,
      handler: async (args) =>
        gateLegacyWrite(sendInmailApproval, args, (a) =>
          handleLinkedinSendInmail(a as Parameters<typeof handleLinkedinSendInmail>[0])
        ),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_engage",
      description:
        "Super-tool: routes to send_message (1st-degree), send_connection (2nd/3rd), " +
        "send_inmail (out-of-network with allow_inmail: true + inmail_subject), or skip. " +
        "Supports dry_run: true to preview the action without executing. " +
        approvalHint({ legacy: true }),
      schema: linkedinEngageSchema,
      handler: async (args) =>
        gateLegacyWrite(engageApproval, args, (a) =>
          handleLinkedinEngage(a as Parameters<typeof handleLinkedinEngage>[0])
        ),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_list_pending",
      description:
        "List pending LinkedIn invitations sent from the account, with age_days. " +
        "Optional older_than_days filter (client-side). " +
        "Returns {count, items: [{invitation_id, recipient_profile_url, recipient_name, sent_at, age_days, has_note}]}.",
      schema: linkedinListPendingSchema,
      handler: async (args) =>
        handleLinkedinListPending(args as Parameters<typeof handleLinkedinListPending>[0]),
      destructive: false,
    }),
    defineTool({
      name: "linkedin_list_inbox",
      description:
        "List LinkedIn conversations (inbox) from the connected account. " +
        "Filters: unread_only, since_days. For 'what came in recently / what's unread'. " +
        "Returns {count, items: [{chat_id, attendee_provider_id, attendee_name, unread, unread_count, last_message_at, folder}]}. " +
        "Read-only — no audit, no rate-limit. Use linkedin_read_messages to read a thread.",
      schema: linkedinListInboxSchema,
      handler: async (args) =>
        handleLinkedinListInbox(args as Parameters<typeof handleLinkedinListInbox>[0]),
      destructive: false,
    }),
    defineTool({
      name: "linkedin_read_messages",
      description:
        "Read the message history of ONE LinkedIn conversation, by chat_id (from linkedin_list_inbox) " +
        "OR profile_url. Returns inbound + outbound messages sorted oldest-first. " +
        "Returns {chat_id, count, items: [{message_id, direction: 'in'|'out', sender_id, text, sent_at, has_attachments}]}. " +
        "Read-only — no audit, no rate-limit. Raw message text IS returned (reading your own inbox is the purpose).",
      schema: linkedinReadMessagesSchema,
      handler: async (args) =>
        handleLinkedinReadMessages(args as Parameters<typeof handleLinkedinReadMessages>[0]),
      destructive: false,
    }),
    defineTool({
      name: "whatsapp_list_inbox",
      description:
        "List WhatsApp conversations (inbox) from the connected WhatsApp account. " +
        "Filters: unread_only, since_days. For 'what came in recently / what's unread on WhatsApp'. " +
        "Returns {count, items: [{chat_id, name, is_group, provider_id, unread, unread_count, last_message_at}]}. " +
        "Read-only — no audit, no rate-limit. Use whatsapp_read_messages to read a thread.",
      schema: whatsappListInboxSchema,
      handler: async (args) =>
        handleWhatsappListInbox(args as Parameters<typeof handleWhatsappListInbox>[0]),
      destructive: false,
    }),
    defineTool({
      name: "whatsapp_read_messages",
      description:
        "Read the message history of ONE WhatsApp conversation, by chat_id (from whatsapp_list_inbox). " +
        "Returns inbound + outbound messages sorted oldest-first. " +
        "Returns {chat_id, count, items: [{message_id, direction: 'in'|'out', sender_id, text, sent_at, has_attachments}]}. " +
        "Read-only — no audit, no rate-limit. Raw message text IS returned (reading your own inbox is the purpose).",
      schema: whatsappReadMessagesSchema,
      handler: async (args) =>
        handleWhatsappReadMessages(args as Parameters<typeof handleWhatsappReadMessages>[0]),
      destructive: false,
    }),
    // ── Spec v2 (ADR 0002) — WhatsApp ──
    defineTool({
      name: "whatsapp_find_chat",
      description:
        "Find a WhatsApp group or 1:1 conversation (and contacts) by name fragment or phone number, to get its chat_id. " +
        "Accent/case-insensitive. Returns {chats: [{chat_id, name, conversation_type, phone, last_message_at, unread_count}], contacts: [{contact_id, name, phone}]}. Read-only.",
      schema: whatsappFindChatSchema,
      handler: async (args) =>
        handleWhatsappFindChat(args as Parameters<typeof handleWhatsappFindChat>[0]),
      destructive: false,
    }),
    defineTool({
      name: "whatsapp_search_messages",
      description:
        "Search WhatsApp messages by keywords (all words must appear, accents ignored), in one chat (chat_id) or across the account, over the last since_days (default 30). " +
        "Scans up to 1000 recent messages. Returns {matches: [{chat_id, chat_name, message_id, direction, sender_id, text, sent_at}], scanned, truncated}. Read-only.",
      schema: whatsappSearchMessagesSchema,
      handler: async (args) =>
        handleWhatsappSearchMessages(args as Parameters<typeof handleWhatsappSearchMessages>[0]),
      destructive: false,
    }),
    defineTool({
      name: "whatsapp_send_message",
      description:
        "Send a WhatsApp message to an existing chat (chat_id — person or group) OR to a phone number (international format). " +
        approvalHint() +
        " " +
        "Daily cap 100, identical sends within 10 min blocked, verified-after-send. Returns {executed, provider_ok, verified, chat_id, message_id, audit_id, preview?, error?}.",
      schema: whatsappSendMessageSchema,
      handler: async (args) =>
        gateGuardedWrite("whatsapp_send_message", args, (a) =>
          handleWhatsappSendMessage(a as Parameters<typeof handleWhatsappSendMessage>[0])
        ),
      destructive: true,
    }),
    // ── Spec v2 (ADR 0002) — LinkedIn ──
    defineTool({
      name: "linkedin_search_messages",
      description:
        "Search LinkedIn messages by keywords (all words must appear, accents ignored), in one conversation (chat_id) or across the inbox, over the last since_days (default 30). " +
        "Returns {matches: [{chat_id, chat_name, message_id, direction, sender_id, text, sent_at}], scanned, truncated}. Read-only.",
      schema: linkedinSearchMessagesSchema,
      handler: async (args) =>
        handleLinkedinSearchMessages(args as Parameters<typeof handleLinkedinSearchMessages>[0]),
      destructive: false,
    }),
    defineTool({
      name: "linkedin_reply",
      description:
        "Reply in an existing LinkedIn conversation by chat_id (from linkedin_list_inbox) — works for any thread (DM, InMail reply, group). " +
        approvalHint() +
        " Shares the 50/day LinkedIn DM cap. Returns {executed, verified, chat_id, message_id, audit_id, preview?, error?}.",
      schema: linkedinReplySchema,
      handler: async (args) =>
        gateGuardedWrite("linkedin_reply", args, (a) =>
          handleLinkedinReply(a as Parameters<typeof handleLinkedinReply>[0])
        ),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_get_profile",
      description:
        "Get a LinkedIn person profile (name, headline, location, degree, connections, summary, current positions, provider_id) " +
        "or company page (name, tagline, industry, size, website, followers) from a URL or public id. Read-only.",
      schema: linkedinGetProfileSchema,
      handler: async (args) =>
        handleLinkedinGetProfile(args as Parameters<typeof handleLinkedinGetProfile>[0]),
      destructive: false,
    }),
    defineTool({
      name: "linkedin_list_connections",
      description:
        "List your 1st-degree LinkedIn connections (most recent first), optionally filtered by words in name/headline (e.g. 'founder fintech'). " +
        "Returns {count, scanned, items: [{first_name, last_name, headline, profile_url, provider_id, connected_at}]}. Read-only.",
      schema: linkedinListConnectionsSchema,
      handler: async (args) =>
        handleLinkedinListConnections(args as Parameters<typeof handleLinkedinListConnections>[0]),
      destructive: false,
    }),
    defineTool({
      name: "linkedin_search",
      description:
        "Search LinkedIn people or companies by keywords, or replay a LinkedIn / Sales Navigator search URL. " +
        "Returns {count, items: [{type, name, headline, location, degree, profile_url, provider_id}]}. Read-only. Use results with linkedin_engage / linkedin_send_connection.",
      schema: linkedinSearchSchema,
      handler: async (args) =>
        handleLinkedinSearch(args as Parameters<typeof handleLinkedinSearch>[0]),
      destructive: false,
    }),
    defineTool({
      name: "linkedin_list_posts",
      description:
        "List recent posts of a LinkedIn person or company (text, date, reactions, comments, url, post_id). " +
        "Use before commenting/reacting for warm outreach. Read-only.",
      schema: linkedinListPostsSchema,
      handler: async (args) =>
        handleLinkedinListPosts(args as Parameters<typeof handleLinkedinListPosts>[0]),
      destructive: false,
    }),
    defineTool({
      name: "linkedin_react_post",
      description:
        "React to a LinkedIn post (like, celebrate, support, love, insightful, funny). Post = URL, urn or post_id. " +
        approvalHint() +
        " Shares a 40/day engagement cap with comments.",
      schema: linkedinReactPostSchema,
      handler: async (args) =>
        gateGuardedWrite("linkedin_react_post", args, (a) =>
          handleLinkedinReactPost(a as Parameters<typeof handleLinkedinReactPost>[0])
        ),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_comment_post",
      description:
        "Comment on a LinkedIn post (≤1250 chars). Post = URL, urn or post_id. " +
        approvalHint() +
        " Shares a 40/day engagement cap with reactions.",
      schema: linkedinCommentPostSchema,
      handler: async (args) =>
        gateGuardedWrite("linkedin_comment_post", args, (a) =>
          handleLinkedinCommentPost(a as Parameters<typeof handleLinkedinCommentPost>[0])
        ),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_create_post",
      description:
        "Publish a public text post (≤3000 chars) from the LinkedIn account. " +
        approvalHint() +
        " Cap 3 posts/day.",
      schema: linkedinCreatePostSchema,
      handler: async (args) =>
        gateGuardedWrite("linkedin_create_post", args, (a) =>
          handleLinkedinCreatePost(a as Parameters<typeof handleLinkedinCreatePost>[0])
        ),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_cancel_invitation",
      description:
        "Withdraw a pending LinkedIn invitation (invitation_id from linkedin_list_pending) — cleans up stale invites to protect your acceptance rate. " +
        approvalHint() +
        " LinkedIn blocks re-inviting the same person for ~3 weeks.",
      schema: linkedinCancelInvitationSchema,
      handler: async (args) =>
        gateGuardedWrite("linkedin_cancel_invitation", args, (a) =>
          handleLinkedinCancelInvitation(a as Parameters<typeof handleLinkedinCancelInvitation>[0])
        ),
      destructive: true,
    }),
  ];
}
