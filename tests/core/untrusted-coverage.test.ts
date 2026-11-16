/**
 * Audit 2026-11 (A5) — no third-party reader may silently escape the
 * untrusted-content framing.
 *
 * Every tool of a connector that reads content written by other people
 * (web, mail, calendars, chats, social, scraped data, issue trackers,
 * webhooks…) must be either framed (EXTERNAL_CONTENT_TOOLS, a provenance
 * rule, or `externalContent: true`) or listed below as NOT third-party with
 * a reason. A new tool in one of these connectors fails this test until
 * someone makes that decision.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/core/config-facade", async (orig) => ({
  ...((await orig()) as object),
  getConfig: () => undefined,
}));

import { EXTERNAL_CONTENT_TOOLS, frameUntrustedResult } from "@/core/untrusted-content";
import type { ConnectorManifest } from "@/core/types";

/** Tools of third-party connectors that return no third-party text — and why. */
const NOT_THIRD_PARTY: Record<string, string> = {
  // Google — writes return a confirmation; these reads return the user's own data.
  gmail_send: "send confirmation (approval-gated)",
  gmail_reply: "send confirmation (approval-gated)",
  gmail_trash: "write confirmation",
  gmail_label: "write confirmation",
  gmail_draft: "write confirmation",
  calendar_create: "write confirmation",
  calendar_delete: "write confirmation",
  calendar_update: "write confirmation",
  calendar_rsvp: "write confirmation",
  calendar_find_free: "busy/free time slots only",
  contacts_search: "the user's own address book fields",
  google_chat_list_spaces: "space names and ids of the user's workspace",
  google_chat_send_message: "send confirmation (approval-gated)",
  // Slack
  slack_send: "send confirmation (approval-gated)",
  slack_send_dm: "send confirmation (approval-gated)",
  // Notion / Airtable / Linear / GitHub — writes and structure only.
  notion_create: "write confirmation",
  notion_update: "write confirmation",
  notion_get_db_schema: "database structure (property names and types)",
  airtable_list_bases: "base names and ids",
  airtable_list_tables: "table and field structure",
  airtable_create_record: "write confirmation",
  airtable_update_record: "write confirmation",
  linear_list_projects: "project names and states",
  linear_create_issue: "write confirmation",
  linear_update_issue: "write confirmation",
  github_create_issue: "write confirmation",
  github_update_issue: "write confirmation",
  github_add_comment: "write confirmation",
  // Unipile (LinkedIn / WhatsApp) — approval-gated writes and network distance.
  linkedin_send_connection: "send confirmation (approval-gated)",
  linkedin_send_message: "send confirmation (approval-gated)",
  linkedin_send_inmail: "send confirmation (approval-gated)",
  linkedin_engage: "send confirmation / routing decision (approval-gated)",
  linkedin_reply: "send confirmation (approval-gated)",
  linkedin_react_post: "write confirmation (approval-gated)",
  linkedin_comment_post: "write confirmation (approval-gated)",
  linkedin_create_post: "write confirmation (approval-gated)",
  linkedin_cancel_invitation: "write confirmation (approval-gated)",
  linkedin_get_relationship_status: "connection degree only",
  whatsapp_send_message: "send confirmation (approval-gated)",
  // Webhooks / Composio — configuration only.
  webhook_list: "webhook names configured by the user",
  composio_list: "catalogue of the user's enabled actions",
};

/** Tools framed by a provenance rule rather than always. */
const PROVENANCE_FRAMED = new Set(["vault_read", "vault_batch_read", "vault_search"]);

async function thirdPartyManifests(): Promise<ConnectorManifest[]> {
  const loaders: Array<() => Promise<ConnectorManifest>> = [
    async () => (await import("@/connectors/browser/manifest")).browserConnector,
    async () => (await import("@/connectors/google/manifest")).googleConnector,
    async () => (await import("@/connectors/slack/manifest")).slackConnector,
    async () => (await import("@/connectors/notion/manifest")).notionConnector,
    async () => (await import("@/connectors/unipile/manifest")).unipileConnector,
    async () => (await import("@/connectors/apify/manifest")).apifyConnector,
    async () => (await import("@/connectors/github/manifest")).githubConnector,
    async () => (await import("@/connectors/linear/manifest")).linearConnector,
    async () => (await import("@/connectors/webhook/manifest")).webhookConnector,
    async () => (await import("@/connectors/composio/manifest")).composioConnector,
    async () => (await import("@/connectors/paywall/manifest")).paywallConnector,
    async () => (await import("@/connectors/airtable/manifest")).airtableConnector,
  ];
  return Promise.all(loaders.map((l) => l()));
}

describe("untrusted framing covers every third-party reader (A5)", () => {
  it("each tool of a third-party connector is framed or explicitly not third-party", async () => {
    const missing: string[] = [];
    for (const m of await thirdPartyManifests()) {
      for (const t of m.tools) {
        const framed = EXTERNAL_CONTENT_TOOLS.has(t.name) || t.externalContent === true;
        if (!framed && !(t.name in NOT_THIRD_PARTY)) missing.push(`${m.id}:${t.name}`);
        if (framed && t.name in NOT_THIRD_PARTY) missing.push(`${m.id}:${t.name} (listed twice)`);
      }
    }
    expect(
      missing,
      "Frame these tools in src/core/untrusted-content.ts, or add them to NOT_THIRD_PARTY with a reason"
    ).toEqual([]);
  }, 30_000);

  it("the allow-list only names tools that exist", async () => {
    const names = new Set<string>();
    for (const m of await thirdPartyManifests()) for (const t of m.tools) names.add(t.name);
    const stale = Object.keys(NOT_THIRD_PARTY).filter((n) => !names.has(n));
    expect(stale).toEqual([]);
  }, 30_000);

  it("frames the readers the audit found unframed", () => {
    const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
    for (const t of ["calendar_events", "web_act", "web_agent", "composio_action"]) {
      expect(frameUntrustedResult(t, ok("x")).content[0]!.text, t).toContain("<untrusted_content");
    }
    for (const t of PROVENANCE_FRAMED) expect(EXTERNAL_CONTENT_TOOLS.has(t)).toBe(false);
  });

  it("frames vault_search only when a result has external provenance", () => {
    const ok = (provenances: string[]) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              count: provenances.length,
              results: provenances.map((p, i) => ({
                name: `n${i}`,
                path: `n${i}.md`,
                provenance: p,
                matches: ['"provenance": "external" quoted in a user note'],
              })),
            },
            null,
            2
          ),
        },
      ],
    });
    expect(
      frameUntrustedResult("vault_search", ok(["user", "external"])).content[0]!.text
    ).toContain("<untrusted_content");
    expect(
      frameUntrustedResult("vault_search", ok(["user", "assistant"])).content[0]!.text
    ).not.toContain("<untrusted_content");
  });
});
