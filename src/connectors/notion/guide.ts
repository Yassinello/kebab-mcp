/**
 * Notion credential guide — extracted into its own module so the connector
 * registry (`src/core/registry.ts`) can surface it on the DISABLED stub
 * manifest without loading the full manifest. Plain markdown, cheap to import.
 *
 * Source of truth lives here; the manifest re-exports it as `guide`.
 */
export const notionGuide = `Search pages, read/append content, and query databases in your Notion workspace via an internal integration token.

### Prerequisites
A Notion workspace where you can install integrations. Notion integrations only see pages that have been _explicitly shared_ with them — there is no workspace-wide permission.

### How to get credentials
1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) and click **New integration**
2. Pick the associated workspace, give it a name (e.g. _Kebab MCP_), and submit
3. Copy the **Internal Integration Token** (starts with \`secret_\` or \`ntn_\`) and set it as \`NOTION_API_KEY\`
4. Open every page or database you want Kebab MCP to access, click **…** → **Connections** → add your integration. Granting a parent page shares all its children.

### Multiple accounts
Once enabled, you can connect more than one Notion workspace/integration from the connector card and pin which one tools act as by default. Override per call with the \`account\` parameter.

### Troubleshooting
- _"object_not_found" or empty search_: the page/database was never shared with the integration — add it via **Connections**.
- _Cannot update properties_: property names are case-sensitive and must match the database schema exactly.
- _API version errors_: Kebab MCP sends \`Notion-Version: 2022-06-28\` — that's still supported.`;
