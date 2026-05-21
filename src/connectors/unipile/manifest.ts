import { UnipileClient } from "unipile-node-sdk";
import { defineTool, type ConnectorManifest, type ToolDefinition } from "@/core/types";
import { getConfig } from "@/core/config-facade";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
import { isWritesDisabled } from "./lib/kill-switch";

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

function countLinkedinAccounts(resp: UnipileAccountListResponse): number {
  const items = resp.items ?? [];
  return items.filter((it) => it?.type === "LINKEDIN").length;
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
  const writes_disabled = isWritesDisabled();
  try {
    const client = new UnipileClient(normalizeDsnForProbe(dsn), token);
    const resp = (await client.account.getAll()) as UnipileAccountListResponse;
    const linkedinCount = countLinkedinAccounts(resp);
    const total = resp.items?.length ?? 0;
    if (linkedinCount >= 1) {
      log.info(`Unipile probe ok: ${linkedinCount} LinkedIn account(s) of ${total} total`);
      return {
        ok: true,
        message: writes_disabled
          ? `Connected — ${linkedinCount} LinkedIn account(s) — ⚠ writes disabled`
          : `Connected — ${linkedinCount} LinkedIn account(s)`,
        writes_disabled,
        accounts: pickerAccounts(resp),
      };
    }
    log.info(`Unipile probe: no LinkedIn account connected (${total} total accounts)`);
    return {
      ok: false,
      message: "No LinkedIn account connected to Unipile token",
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
    "Send LinkedIn connection requests, read relationship status, and read LinkedIn + WhatsApp inboxes via Unipile's managed-browser API.",
  guide: `Use Unipile's managed-browser API to send LinkedIn connection requests and read relationship signals from the server side — no DOM automation, no Browserbase session juggling.

### Prerequisites
A [Unipile](https://www.unipile.com) account with at least one LinkedIn account connected through the Unipile dashboard. The connected LinkedIn account is what actually fires the connection request — Unipile is the API layer in front of it.

### How to get credentials
1. Sign in to the [Unipile dashboard](https://dashboard.unipile.com).
2. Open **Settings → API** and copy your **DSN** (e.g. \`api41.unipile.com:17153\`) — set it as \`UNIPILE_DSN\`.
3. From the same screen, copy your **API Token** and set it as \`UNIPILE_TOKEN\`.
4. In **Accounts → Add account**, connect a LinkedIn account (Sales Navigator-tier recommended for higher daily quotas).
5. Paste both env vars in the /config Credentials tab and click Test. The probe calls Unipile and verifies that at least one LinkedIn account is wired — without that you get connected-but-useless ambiguity.

### Notes
- Phase 69 complete: 6 tools available (2 from phase 68 + 4 from phase 69) — \`linkedin_send_connection\`, \`linkedin_get_relationship_status\`, \`linkedin_send_message\`, \`linkedin_send_inmail\`, \`linkedin_engage\`, \`linkedin_list_pending\`.
- Audit log entries live 90 days in Upstash KV and store only a SHA-256 of \`{tool, profile_url, note}\` — never the note text itself.
- Per-account daily/weekly caps enforced by the kebab-side rate-limiter (defaults: 25/day, 100/week for connects; 50/day for DMs; 15/day for InMail). Override via \`KEBAB_UNIPILE_LINKEDIN_*_CAP\` env vars.`,
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
        "Returns {provider_ok, verified, crm_sync: 'pending', dedup_hit, audit_id, invitation_id?, error?, blocked_by_rate_limit?}.",
      schema: linkedinSendConnectionSchema,
      handler: async (args) =>
        handleLinkedinSendConnection(args as Parameters<typeof handleLinkedinSendConnection>[0]),
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
        "Verified-after-write (polls at 5s + 10s). Refuses if recipient is not 1st-degree.",
      schema: linkedinSendMessageSchema,
      handler: async (args) =>
        handleLinkedinSendMessage(args as Parameters<typeof handleLinkedinSendMessage>[0]),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_send_inmail",
      description:
        "Send a LinkedIn InMail (paid). REQUIRES allow_inmail: true to confirm credit usage. " +
        "Tracks credits_used / credits_remaining via inmail_balance bracketing. " +
        "Requires Premium / Sales Navigator / Recruiter subscription.",
      schema: linkedinSendInmailSchema,
      handler: async (args) =>
        handleLinkedinSendInmail(args as Parameters<typeof handleLinkedinSendInmail>[0]),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_engage",
      description:
        "Super-tool: routes to send_message (1st-degree), send_connection (2nd/3rd), " +
        "send_inmail (out-of-network with allow_inmail: true + inmail_subject), or skip. " +
        "Supports dry_run: true to preview the action without executing.",
      schema: linkedinEngageSchema,
      handler: async (args) =>
        handleLinkedinEngage(args as Parameters<typeof handleLinkedinEngage>[0]),
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
  ];
}
