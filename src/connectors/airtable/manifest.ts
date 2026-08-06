import { defineTool, type ConnectorManifest } from "@/core/types";
import { airtableRequest } from "./lib/airtable-api";
import { airtableListBasesSchema, handleAirtableListBases } from "./tools/airtable_list_bases";
import { airtableListTablesSchema, handleAirtableListTables } from "./tools/airtable_list_tables";
import {
  airtableListRecordsSchema,
  handleAirtableListRecords,
} from "./tools/airtable_list_records";
import { airtableGetRecordSchema, handleAirtableGetRecord } from "./tools/airtable_get_record";
import {
  airtableCreateRecordSchema,
  handleAirtableCreateRecord,
} from "./tools/airtable_create_record";
import {
  airtableUpdateRecordSchema,
  handleAirtableUpdateRecord,
} from "./tools/airtable_update_record";
import {
  airtableSearchRecordsSchema,
  handleAirtableSearchRecords,
} from "./tools/airtable_search_records";
import {
  airtableListCommentsSchema,
  handleAirtableListComments,
} from "./tools/airtable_list_comments";
import {
  airtableCreateCommentSchema,
  handleAirtableCreateComment,
} from "./tools/airtable_create_comment";

interface BasesResponse {
  bases: Array<{ id: string; name: string }>;
}

export const airtableConnector: ConnectorManifest = {
  id: "airtable",
  label: "Airtable",
  description: "List, read, create, update, and search records across Airtable bases and tables",
  guide: `Read, write, and search records across your Airtable bases and tables via a personal access token.

### Prerequisites
An Airtable account with access to at least one base. Free plans work fine.

### How to get credentials
1. Go to [airtable.com/create/tokens](https://airtable.com/create/tokens) and click **Create new token**
2. Give it a name (e.g. _MyMCP_) and add the scopes \`data.records:read\`, \`data.records:write\`, and \`schema.bases:read\`
3. Under **Access**, add every base you want Kebab MCP to reach (you must pick them explicitly — tokens are not workspace-wide)
4. Copy the generated token and set it as \`AIRTABLE_API_KEY\`

### Troubleshooting
- _"NOT_FOUND" on a base_: the token was not granted access to that specific base — edit the token and add it.
- _Token starts with \`key...\`_: those are legacy API keys and are being deprecated. Prefer a new personal access token (\`pat...\`).`,
  requiredEnvVars: ["AIRTABLE_API_KEY"],
  testConnection: async (credentials) => {
    const key = credentials.AIRTABLE_API_KEY;
    if (!key) return { ok: false, message: "Missing Airtable API Key" };
    try {
      const res = await fetch("https://api.airtable.com/v0/meta/bases", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) {
        const data = (await res.json()) as BasesResponse;
        return {
          ok: true,
          message: `Connected — ${data.bases.length} accessible base(s)`,
        };
      }
      const errBody = await res.text();
      return {
        ok: false,
        message: `Airtable API error: ${res.status} - ${errBody || res.statusText}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Cannot reach Airtable API",
      };
    }
  },
  diagnose: async () => {
    try {
      const data = await airtableRequest<BasesResponse>("/meta/bases");
      return { ok: true, message: `Connected — ${data.bases.length} accessible base(s)` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Cannot reach Airtable API",
      };
    }
  },
  tools: [
    defineTool({
      name: "airtable_list_bases",
      description:
        "List all Airtable bases accessible with the current API key, including IDs and permission levels.",
      schema: airtableListBasesSchema,
      handler: async () => handleAirtableListBases(),
      destructive: false,
    }),
    defineTool({
      name: "airtable_list_tables",
      description: "List all tables in an Airtable base, including fields and views.",
      schema: airtableListTablesSchema,
      handler: async (args) => handleAirtableListTables(args),
      destructive: false,
    }),
    defineTool({
      name: "airtable_list_records",
      description:
        "List records in an Airtable table. Supports optional view, filter formula, sort, and limit (default 25, max 100).",
      schema: airtableListRecordsSchema,
      handler: async (args) => handleAirtableListRecords(args),
      destructive: false,
    }),
    defineTool({
      name: "airtable_get_record",
      description: "Get a single Airtable record by ID with all its field values.",
      schema: airtableGetRecordSchema,
      handler: async (args) => handleAirtableGetRecord(args),
      destructive: false,
    }),
    defineTool({
      name: "airtable_create_record",
      description:
        "Create a new record in an Airtable table. Always confirm field values with the user before calling.",
      schema: airtableCreateRecordSchema,
      handler: async (args) => handleAirtableCreateRecord(args),
      destructive: true,
    }),
    defineTool({
      name: "airtable_update_record",
      description:
        "Partially update an existing Airtable record (PATCH — untouched fields are preserved). Always confirm changes with the user before calling.",
      schema: airtableUpdateRecordSchema,
      handler: async (args) => handleAirtableUpdateRecord(args),
      destructive: true,
    }),
    defineTool({
      name: "airtable_search_records",
      description:
        "Search records in an Airtable table using a case-insensitive text match on a specified field.",
      schema: airtableSearchRecordsSchema,
      handler: async (args) => handleAirtableSearchRecords(args),
      destructive: false,
    }),
    defineTool({
      name: "airtable_list_comments",
      description: "List all comments on an Airtable record.",
      schema: airtableListCommentsSchema,
      handler: async (args) => handleAirtableListComments(args),
      destructive: false,
    }),
    defineTool({
      name: "airtable_create_comment",
      description:
        "Add a comment to an Airtable record. Mentions can be formatted as @[user name or email]. Always confirm comment text with the user before calling.",
      schema: airtableCreateCommentSchema,
      handler: async (args) => handleAirtableCreateComment(args),
      destructive: true,
    }),
  ],
};
