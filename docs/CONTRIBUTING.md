# Contributing to Kebab MCP

Thank you for considering a contribution. Kebab MCP grows through community connectors — every new integration you add makes the tool more useful for every developer who deploys it.

## Code of Conduct

All interactions on this project — issues, pull requests, discussions — are governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to abide by it.

## Table of Contents

- [Ways to Contribute](#ways-to-contribute)
- [Good First Issues](#good-first-issues)
- [Connector Ideas Wanted](#connector-ideas-wanted)
- [Architecture Overview](#architecture-overview)
- [Adding a Tool](#adding-a-tool)
- [Adding a Connector (step by step)](#adding-a-connector-step-by-step)
- [Custom Connector (personal tools)](#custom-connector-for-your-own-tools)
- [Writing Tests](#writing-tests)
- [Code Conventions](#code-conventions)
- [Running Locally](#running-locally)
- [Pull Request Process](#pull-request-process)
- [Commit Convention](#commit-convention)
- [Getting Help](#getting-help)

---

## Ways to Contribute

| Type | What it looks like |
|------|-------------------|
| **New connector** | A new integration with an external service (Linear, Airtable, HubSpot…) |
| **New tool in existing connector** | Add a missing endpoint to Google, Slack, Notion, etc. |
| **Bug fix** | Something isn't working as documented |
| **Docs** | Improve this guide, the README, or inline tool descriptions |
| **Issue triage** | Reproduce bugs, label issues, ask clarifying questions |

Not sure where to start? Check [Good First Issues](#good-first-issues) below.

---

## Good First Issues

Look for the `good first issue` label on GitHub. These are scoped tasks with clear acceptance criteria and no deep architectural knowledge required.

**Examples of what good-first issues look like:**

- Add a missing tool to an existing connector (e.g., `google_drive_upload`, `slack_reactions`)
- Fix a tool description that is confusing or inaccurate
- Add a contract test for a connector that lacks coverage
- Improve error messages in an existing tool handler
- Add `.env.example` documentation for a new env var

If you want to propose a good first issue yourself, open an issue with the `good first issue` label and a short description.

---

## Connector Ideas Wanted

The following connectors are on the roadmap and would make great community contributions:

| Connector | Key tools | API docs |
|------|-----------|----------|
| **Linear** | list issues, create issue, update issue, search | [docs](https://developers.linear.app/docs) |
| **Airtable** | list records, create record, update, query | [docs](https://airtable.com/developers/web/api/introduction) |
| **HubSpot** | contacts, companies, deals, notes | [docs](https://developers.hubspot.com/docs/api/overview) |
| **Jira** | list issues, create, update, search | [docs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) |
| **GitHub PRs** | list PRs, review, comment | [docs](https://docs.github.com/en/rest) |
| **Todoist** | tasks, projects, labels | [docs](https://developer.todoist.com/rest/v2/) |
| **Raindrop** | bookmarks, collections, search | [docs](https://developer.raindrop.io) |
| **Readwise** | highlights, books, articles | [docs](https://readwise.io/api_deets) |

Have an idea not on this list? Open a [New Connector](https://github.com/Yassinello/kebab-mcp/issues/new?template=new-connector.md) issue.

---

## Architecture Overview

```
src/
  core/           ← Framework-level code (types, registry, config, auth, logging)
  connectors/
    google/       ← Google Workspace connector (18 tools)
    vault/        ← Obsidian Vault connector (14 tools)
    browser/      ← Browser Automation connector (4 tools)
    slack/        ← Slack connector (6 tools)
    notion/       ← Notion connector (5 tools)
    apify/        ← Apify — LinkedIn + actors (8 tools)
    admin/        ← Admin & Observability connector (1 tool)
```

### Framework vs Instance

**Framework-level** (lives in code, shared by all users):
- Connector manifests, registry logic, types, auth model, dashboard structure

**Instance-level** (lives in env vars, unique per user):
- Secrets, display name, timezone, locale, active connectors

**Rule:** If it's personal or changes per deployment, it MUST be an env var, never hardcoded.

### How a connector activates

1. Connector declares `requiredEnvVars` in its manifest
2. Registry checks at startup: if all required env vars are set → connector activates
3. Tools from active connectors are registered on the MCP endpoint
4. Dashboard, health endpoint, and admin API derive their state from the registry

---

## Adding a Tool

1. Create `src/connectors/<connector>/tools/my-tool.ts`:

```typescript
import { z } from "zod";

export const myToolSchema = {
  input: z.string().describe("What this input does"),
};

export async function handleMyTool(params: { input: string }) {
  // Your logic here
  return {
    content: [{ type: "text" as const, text: "Result" }],
  };
}
```

2. Add it to the connector manifest (`src/connectors/<connector>/manifest.ts`):

```typescript
import { myToolSchema, handleMyTool } from "./tools/my-tool";

// Add to the tools array:
{
  name: "my_tool",
  description: "What this tool does",
  schema: myToolSchema,
  handler: async (params) => handleMyTool(params as { input: string }),
}
```

That's it. The registry picks it up automatically.

---

## Adding a Connector (step by step)

### Step 1 — Create the directory structure

```
src/connectors/myconnector/
  manifest.ts       ← Connector definition (single source of truth)
  lib/              ← API client, helpers, auth wrappers
  tools/            ← One file per tool
    my-tool-one.ts
    my-tool-two.ts
```

### Step 2 — Write the manifest

```typescript
// src/connectors/myconnector/manifest.ts
import type { ConnectorManifest } from "@/core/types";
import { myToolOneSchema, handleMyToolOne } from "./tools/my-tool-one";
import { myToolTwoSchema, handleMyToolTwo } from "./tools/my-tool-two";

export const myConnector: ConnectorManifest = {
  id: "myconnector",
  label: "My Service",
  description: "What this connector enables (one sentence)",
  requiredEnvVars: ["MYSERVICE_API_KEY"],
  tools: [
    {
      name: "myconnector_action_one",
      description: "What this tool does. Be specific — this text goes in the MCP tool description.",
      schema: myToolOneSchema,
      handler: async (params) => handleMyToolOne(params as Parameters<typeof handleMyToolOne>[0]),
    },
    {
      name: "myconnector_action_two",
      description: "What this tool does.",
      schema: myToolTwoSchema,
      handler: async (params) => handleMyToolTwo(params as Parameters<typeof handleMyToolTwo>[0]),
    },
  ],
};
```

### Step 3 — Write the tools

Each tool file exports a Zod schema and a handler function:

```typescript
// src/connectors/myconnector/tools/my-tool-one.ts
import { z } from "zod";

export const myToolOneSchema = {
  query: z.string().describe("Search query"),
  limit: z.number().optional().default(10).describe("Max results to return"),
};

export async function handleMyToolOne(params: {
  query: string;
  limit?: number;
}) {
  const apiKey = process.env.MYSERVICE_API_KEY!;
  // Call your API here
  const results = await fetchFromMyService(apiKey, params.query, params.limit ?? 10);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(results, null, 2),
      },
    ],
  };
}
```

### Step 4 — Register the connector

Add your connector to `src/core/registry.ts`:

```typescript
import { myConnector } from "@/connectors/myconnector/manifest";

const ALL_CONNECTORS: ConnectorManifest[] = [
  googleConnector,
  vaultConnector,
  // ... existing connectors ...
  myConnector,  // ← Add here
];
```

### Step 5 — Document env vars

Add required env vars to `.env.example`:

```bash
# My Service Connector
# Get your API key at: https://myservice.com/settings/api
MYSERVICE_API_KEY=
```

### Step 6 — Write tests

See [Writing Tests](#writing-tests) below.

### Step 7 — Update the README

Add your connector to the Connectors section in `README.md`:

```markdown
### My Service — N tools

| Tool | What it does |
|------|-------------|
| `myconnector_action_one` | Description |
| `myconnector_action_two` | Description |

**Requires:** `MYSERVICE_API_KEY`
```

Also update the tool count in the README header and architecture diagram.

---

## Custom Connector (for your own tools)

If you want to add personal tools without modifying the framework:

1. Create `src/connectors/custom/manifest.ts`:

```typescript
import type { ConnectorManifest } from "@/core/types";
import { myToolSchema, handleMyTool } from "./tools/my-tool";

export const customConnector: ConnectorManifest = {
  id: "custom",
  label: "Custom Tools",
  description: "Your personal tools",
  requiredEnvVars: [], // or your own env vars
  tools: [
    {
      name: "my_tool",
      description: "What it does",
      schema: myToolSchema,
      handler: async (params) => handleMyTool(params as { input: string }),
    },
  ],
};
```

2. Register in `src/core/registry.ts`:
```typescript
import { customConnector } from "@/connectors/custom/manifest";
const ALL_CONNECTORS = [...existing, customConnector];
```

3. Add `src/connectors/custom/` to `.gitignore` if you don't want it tracked upstream.

---

## Deprecating a Tool

Add a `deprecated` field to the tool definition:

```typescript
{
  name: "old_tool",
  description: "This tool does X",
  deprecated: "Use new_tool instead", // Shows warning in dashboard + MCP description
  schema: oldToolSchema,
  handler: async (params) => handleOldTool(params),
}
```

---

## Writing Tests

### Contract tests (required for new connectors)

Contract tests verify tool schemas are valid and tools are registered correctly. Add a contract test for your connector in `src/connectors/myconnector/__tests__/contract.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { myConnector } from "../manifest";

describe("myConnector contract", () => {
  it("has required fields", () => {
    expect(myConnector.id).toBe("myconnector");
    expect(myConnector.label).toBeTruthy();
    expect(myConnector.requiredEnvVars).toBeInstanceOf(Array);
    expect(myConnector.tools.length).toBeGreaterThan(0);
  });

  it("all tools have name and description", () => {
    for (const tool of myConnector.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("tool names follow naming convention", () => {
    for (const tool of myConnector.tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
```

### Running tests

```bash
npm run test:contract   # Contract tests for all connectors
npm run test:e2e        # Full E2E smoke test (starts server, checks tool listing)
npm test                # All tests
```

---

## Coverage philosophy — risk-weighted, not global %

### What we reject

"80% global line coverage" as a quality target. Per [POST-V0.11-AUDIT §B](.planning/research/POST-V0.11-AUDIT.md) and the GPT review that shaped the v0.12 roadmap, a global-% target rewards testing trivial getters while leaving the high-risk surface (welcome flow, auth, KV, bootstrap) under-tested. A 46% → 80% ratchet would have pushed us to write tests against render helpers and Zod schemas that barely fail; it would NOT have caught the v0.11 mint-race foot-gun (Phase 46).

### What we do instead

Nine **priority paths** carry a `≥ 65%` line-coverage **target**, measured via `npx vitest run --coverage`. It is reviewed by hand — it is **not** enforced by a per-path vitest threshold yet:

| Path | Rationale |
| --- | --- |
| `app/api/welcome/*` | First-run mint race, 409 winner/loser split, auto-magic Vercel write |
| `app/api/[transport]/route.ts` | MCP endpoint — auth + rate-limit + pipeline entry |
| `src/core/auth.ts` | Token + cookie auth, Phase 50 dual-name transition |
| `src/core/first-run.ts` | Bootstrap rehydrate, flushBootstrapToKvIfAbsent race arbitration |
| `src/core/signing-secret.ts` | Admin-claim signature; SEC-05 degraded-mode contract |
| `src/core/kv-store.ts` | Upstash/Filesystem/Memory backend swap, TTL edges |
| `src/core/pipeline.ts` + `pipeline/*` | Every route composes through this |
| `src/core/rate-limit.ts` | Per-tenant bucket isolation (Phase 42) |
| `src/core/credential-store.ts` | Encrypt/decrypt roundtrip, corrupt ciphertext |

The CI-enforced gate is the global ratchet in `vitest.config.ts` (statements / branches / functions / lines, measured over `src/`, `app/` and `proxy.ts`).

### Behavioral tests, not grep-contracts

Proxy / middleware / welcome-flow tests must exercise real branches, not regex-match imports. Phase 40 shipped several grep-contract tests (TEST-04 proxy coverage) as stopgaps. Phase 50 replaced them with behavioral coverage (`tests/core/proxy-behavioral.test.ts`). Grep contracts remain acceptable ONLY when production code cannot be imported without refactor (module-private helpers).

### Ratchet discipline

`vitest.config.ts` locks all four global metrics at `floor(measured) - 1` (re-baselined in 2026-11 when `app/` and `proxy.ts` joined the coverage scope). CI fails when a PR drops below. **No bumping down.** Adding net-new code that misses the floor means the PR adds tests before merging.

### Connector lib policy

High-churn libs carry a `≥ 60%` local floor per lib family:
- `src/connectors/google/lib/*` (calendar, drive, gmail, contacts)
- `src/connectors/vault/lib/github.ts`
- `src/connectors/apify/lib/client.ts`
- `src/connectors/slack/lib/slack-api.ts`

Low-churn libs (paywall, webhook) are grandfathered until their manifest changes.

### When to add tests

**Always**:
- New error paths (`throw` or `McpToolError(...)`)
- New KV writes (any `kv.set` / `kv.setIfNotExists` / `kv.delete`)
- New auth checks (`checkMcpAuth`, `checkAdminAuth`, `withAdminAuth`)
- New tenant-scoped reads (`getTenantKVStore(...)`)
- New pipeline steps (under `src/core/pipeline/*`)

**Rarely**:
- UI layout changes (render tests catch hydration bugs, not rendering perf)
- Glue code (import/export wiring — contract tests catch drift)
- Type-only refactors (TS compiler is the test)

### Source references

- [POST-V0.11-AUDIT](.planning/research/POST-V0.11-AUDIT.md) §B — "Reject 80% metric chase"
- Phase 43 ratchet introduction → FOLLOW-UP
- Phase 50 risk-weighted push → CHANGELOG v0.12

---

## Code Conventions

- All tool handlers export `{ schema, handler }` pattern
- Every tool is wrapped in `withLogging()` via the registry
- Use `getInstanceConfig()` for timezone/locale, never hardcode
- No personal references in framework code (no "your", "my", specific names in descriptions)
- TypeScript strict mode, no `any` in public APIs
- Tool names: `connectorid_verb_noun` — e.g., `google_calendar_create`, `slack_send`
- Descriptions are generic and explain what the tool does (not who uses it)

---

## Running Locally

```bash
cp .env.example .env
# Fill in the credentials for the connectors you want to test
npm install
npm run dev             # http://localhost:3000
```

To test your connector is registered:
```bash
curl http://localhost:3000/api/health
# Should show your connector in the active connectors list
```

Pre-commit hook runs `lint-staged` + contract tests. Fix any failures before pushing.

---

## Pull Request Process

1. **Fork** the repo and create a branch: `feat/myconnector` or `fix/slack-send-encoding`
2. **Build your change** following the architecture above
3. **Add tests** — contract tests are required for new connectors
4. **Run the full suite** locally: `npm run lint && npm run test:contract && npm run build`
5. **Open a PR** with:
   - A clear title: `feat: add Linear connector (6 tools)` or `fix: handle empty vault search results`
   - A description of what it does and what credentials are needed
   - Any relevant API documentation links
6. **Respond to review** — a maintainer will review within a few days

### PR Checklist

- [ ] New connector: manifest + tools + contract tests + `.env.example` docs + README update
- [ ] New tool in existing connector: tool file + manifest entry + test coverage
- [ ] Bug fix: description of root cause + test that would have caught it
- [ ] No `any` in public APIs
- [ ] Tool descriptions are generic (no personal references)
- [ ] `npm run lint` passes
- [ ] `npm run test:contract` passes
- [ ] `npm run build` passes

---

## Commit Convention

```
feat: add new tool/feature
fix: bug fix
refactor: code restructure
docs: documentation changes
test: test additions or fixes
chore: maintenance
```

Examples:
```
feat: add Linear connector with 6 tools (list, get, create, update, comment, search)
fix: handle empty results in vault_search
docs: add Airtable to connector ideas list
```

---

## Security & supply chain policy

CI runs `node scripts/audit-gate.mjs` on every push and pull request. The gate enforces:

- **FAIL** on any `high` or `critical` vulnerability (any scope).
- **FAIL** on `moderate` direct-dep vulnerabilities unless explicitly allowlisted in `scripts/audit-gate.mjs` with a reason and a `reviewBy` date.
- **WARN** on `moderate` transitive-dep vulnerabilities (often un-fixable without upstream action; tracked, not blocking).

### Adding an allowlist entry

When a direct-dep `moderate` vulnerability cannot be patched short-term (e.g., requires an upstream major-version bump), add an entry to the `ALLOWLIST` array in `scripts/audit-gate.mjs` with:

- `pkg` — the direct-dep package name
- `reason` — the specific CVE/GHSA + mitigation (feature flag, runtime guard, etc.)
- `reviewBy` — a date 3-6 months out when the entry must be re-evaluated

Review expired entries at every milestone boundary.

### Handling a new CVE

1. Confirm with `node scripts/audit-gate.mjs` locally.
2. If direct-dep: bump the package or allowlist with justification.
3. If transitive-dep: open an upstream issue; document in FOLLOW-UP if tracking long-term.
4. If the fix requires a breaking bump, prefer a feature flag (see `KEBAB_BROWSER_CONNECTOR_V2` for the pattern).

---

## Getting Help

- **GitHub Issues** — bug reports and feature requests
- **GitHub Discussions** — questions, ideas, show your setup
- **Discord** — real-time chat with maintainers and contributors

If you're not sure whether an idea is a good fit before writing code, open an issue or discussion first. We'd rather align upfront than have you build something that needs major rework.

---

*Kebab MCP grows through community contributions. Every connector you add makes it more useful for every developer who deploys it.*
