import { defineTool, type ConnectorManifest } from "@/core/types";
import { webhookLastSchema, handleWebhookLast } from "./tools/webhook-last";
import { webhookListSchema, handleWebhookList } from "./tools/webhook-list";
import { webhookHistorySchema, handleWebhookHistory } from "./tools/webhook-history";

export const webhookConnector: ConnectorManifest = {
  id: "webhook",
  label: "Webhook Receiver",
  description: "Receive and store external webhook payloads for retrieval via MCP tools",
  guide: `Expose your Kebab House instance as a webhook target so external services (Stripe, GitHub, Zapier, Make, n8n, your own apps) can POST events that you later replay through MCP tools.

Unlike the other connectors, there's no third-party account to set up — you publish endpoints under your own deployment.

### Prerequisites
- A publicly reachable URL for this Kebab House instance (Vercel, Cloudflare, your own host). Localhost works too if your sender can reach it (e.g. via a tunnel like \`ngrok http 3000\`).
- Persistent storage configured (Upstash KV in production), otherwise stored payloads vanish on cold starts.

### How to set it up
1. Pick one or more **webhook names** — short, lowercase, no spaces (e.g. \`stripe\`, \`github\`, \`crm-orders\`). These become the URL paths.
2. Set \`MYMCP_WEBHOOKS\` to the comma-separated list (e.g. \`stripe,github,crm-orders\`). Names not in this allowlist are rejected with **404**.
3. Each webhook is now reachable at \`POST https://<your-host>/api/webhook/<name>\`. Configure that URL in the source service.
4. **Optional but recommended** — set a per-webhook HMAC secret to verify payload authenticity:
   - Env var: \`MYMCP_WEBHOOK_SECRET_<NAME>\` (uppercase, hyphens become underscores). Example: \`MYMCP_WEBHOOK_SECRET_CRM_ORDERS\` for a webhook named \`crm-orders\`.
   - The sender must include an \`X-Webhook-Signature\` header with the **HMAC-SHA256 hex digest** of the raw request body using that secret.
5. Fetch payloads through MCP via \`webhook_last\`, \`webhook_list\`, or \`webhook_history\`.

### Limits & defaults
- Max payload size: **1 MB** (returns **413** above that).
- Optional rate limit: **30 requests / minute / IP** when \`MYMCP_RATE_LIMIT_ENABLED=true\`.
- History size: configurable via \`MYMCP_WEBHOOK_HISTORY_SIZE\` (default 10 most recent payloads per webhook).

### Troubleshooting
- _404 Webhook not found_: the name in the URL isn't listed in \`MYMCP_WEBHOOKS\`. Names are case-insensitive but must match the comma-separated list exactly otherwise.
- _401 Invalid signature_: signature verification is opt-in but **becomes required** the moment \`MYMCP_WEBHOOK_SECRET_<NAME>\` is set. Either remove the secret or compute \`X-Webhook-Signature\` correctly on the sender.
- _Payloads disappear after a few minutes_: you're on Vercel without Upstash — \`/tmp\` storage is recycled. Configure Upstash in **Storage** to persist.
- _Connector stays "Inactive" after saving_: \`MYMCP_WEBHOOKS\` must be **non-empty**. An empty list disables the connector entirely.`,
  requiredEnvVars: [],
  isActive: (env) => {
    const webhooks = env.MYMCP_WEBHOOKS?.trim();
    if (!webhooks) {
      return { active: false, reason: "MYMCP_WEBHOOKS not set" };
    }
    return { active: true };
  },
  tools: [
    defineTool({
      name: "webhook_last",
      description:
        "Retrieve the most recent payload received for a named webhook. Returns the payload, timestamp, and content type.",
      schema: webhookLastSchema,
      handler: async (args) => handleWebhookLast(args),
      destructive: false,
    }),
    defineTool({
      name: "webhook_list",
      description:
        "List all named webhooks that have received at least one payload. Returns webhook names and last-received timestamps.",
      schema: webhookListSchema,
      handler: async () => handleWebhookList(),
      destructive: false,
    }),
    defineTool({
      name: "webhook_history",
      description:
        "Retrieve the last N payloads received for a named webhook, newest first. Useful for replaying or auditing webhook deliveries.",
      schema: webhookHistorySchema,
      handler: async (args) => handleWebhookHistory(args as { name: string; limit: number }),
      destructive: false,
    }),
  ],
};
