# Connector Authoring Guide

Build a connector from zero to live in under 30 minutes.

## Prerequisites

- Node 22+, Kebab MCP checked out, `npm install` done.
- Read [CONNECTORS.md](CONNECTORS.md) §§ Architecture + Pipeline first — this doc skips the conceptual model.
- A target service (e.g. Linear, HackerNews, an internal REST API). You'll need its base URL, auth scheme, and rate-limit behavior.

The example below builds a tiny `hello` connector with one tool `say_hi` to keep the walkthrough concrete. Swap the business logic for your target service.

---

## Step 1: Manifest

Create `src/connectors/hello/manifest.ts`:

```typescript
import type { ConnectorManifest } from "@/core/types";
import { schema as sayHiSchema, handler as sayHiHandler } from "./tools/say-hi";

export const helloManifest: ConnectorManifest = {
  id: "hello",
  name: "Hello World",
  description: "Demo connector — a starting template for new integrations.",
  requiredEnvVars: ["HELLO_API_KEY"],
  tools: [
    {
      name: "hello_say_hi",
      description: "Send a greeting to the external service.",
      schema: sayHiSchema,
      handler: sayHiHandler,
    },
  ],
  testConnection: async (credentials: Record<string, string>) => {
    // Called by POST /api/setup/test when the operator saves credentials.
    // Return { ok: true } when the credentials authenticate successfully.
    const apiKey = credentials.HELLO_API_KEY;
    if (!apiKey) return { ok: false, error: "HELLO_API_KEY missing" };
    // ...actual HTTP probe to your service...
    return { ok: true };
  },
};

export default helloManifest;
```

**Required fields:**
- `id` — unique lowercase string; used in env var prefixes (`MYMCP_DISABLE_HELLO`) and tool names (`hello_*`).
- `name` — human-readable for the dashboard.
- `requiredEnvVars` — ALL must be present for the connector to activate. Missing any → connector appears disabled with a reason.
- `tools` — array of `{ schema, handler }` pairs.

**Optional fields:**
- `testConnection` — the dashboard's "Test" button calls this with draft credentials BEFORE they're persisted (Phase 43 `loadConnectorManifest(id)` escape hatch).
- `resources` (Phase 50) — expose a `ResourceProvider` for `resources/list` + `resources/read` MCP capability.
- `isActive(env)` — custom predicate to override default requiredEnvVars check.

---

## Step 2: Tool handler

Create `src/connectors/hello/tools/say-hi.ts`:

```typescript
import { z } from "zod";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";
import { McpToolError, ErrorCode } from "@/core/errors";
import { fetchWithTimeout } from "@/core/fetch-utils";
import type { ToolResult } from "@/core/types";

export const schema = z.object({
  name: z.string().min(1).describe("Name to greet"),
});

export async function handler(params: z.infer<typeof schema>): Promise<ToolResult> {
  const apiKey = getConfig("HELLO_API_KEY");
  if (!apiKey) {
    throw new McpToolError({
      code: ErrorCode.CONFIGURATION_ERROR,
      toolName: "hello_say_hi",
      message: "HELLO_API_KEY not configured",
      userMessage:
        "Hello pack is not configured. Add HELLO_API_KEY to your environment variables.",
      retryable: false,
    });
  }

  try {
    const res = await fetchWithTimeout(
      "https://api.hello.example.com/greet",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: params.name }),
      },
      10_000
    );
    if (!res.ok) {
      throw new Error(`Hello API error: ${res.status}`);
    }
    const data = (await res.json()) as { greeting: string };
    return { content: [{ type: "text", text: data.greeting }] };
  } catch (err) {
    throw new McpToolError({
      code: ErrorCode.EXTERNAL_API_ERROR,
      toolName: "hello_say_hi",
      message: toMsg(err),
      userMessage: `Hello API failed: ${toMsg(err)}`,
      retryable: true,
    });
  }
}
```

**Pattern notes:**
- `{ schema, handler }` — both exports MANDATORY. The registry auto-wires both.
- `getConfig("HELLO_API_KEY")` NOT `process.env.HELLO_API_KEY` — ESLint's `kebab/no-direct-process-env` rule rejects direct reads (Phase 48 FACADE-03). The facade handles per-tenant overrides + Phase 50 `KEBAB_*` / `MYMCP_*` aliasing for free.
- `toMsg(err)` NOT `err instanceof Error ? err.message : String(err)` — Phase 49's `src/core/error-utils.ts` dedupes the ternary pattern; a contract test prevents re-introduction.
- `McpToolError` carries `userMessage` (shown to the LLM), `recovery` (actionable hint), `internalRecovery` (logged server-side only — never surfaced).
- `fetchWithTimeout` NOT raw `fetch` — Phase 44 consolidation. Default timeout 30s is handled by `withLogging()` wrapper; the explicit arg (10_000 above) applies on a per-call basis.

---

## Step 3: Register in registry

Edit `src/core/registry.ts` and add to `ALL_CONNECTOR_LOADERS`:

```diff
 const ALL_CONNECTOR_LOADERS: ConnectorLoaderEntry[] = [
   // ...existing loaders...
+  {
+    id: "hello",
+    requiredEnvVars: ["HELLO_API_KEY"],
+    toolCount: 1,
+    load: () => import("../connectors/hello/manifest").then((m) => m.helloManifest),
+  },
 ];
```

Phase 43 introduced the lazy loader pattern — disabled connectors never import their manifest module, cutting cold-start cost.

**Invariants checked by the registry contract test** (`tests/contract/registry-metadata-consistency.test.ts`):
- `toolCount` matches the lazy manifest's actual tool count.
- `requiredEnvVars` matches the loaded manifest's `requiredEnvVars`.

---

## Step 4: .env.example

Add to `.env.example`:

```dotenv
# Hello Connector (optional)
# Required for the `hello_*` tools. Get your key from https://hello.example.com/dashboard.
HELLO_API_KEY=
```

Use the **bare** env var name (no `KEBAB_` / `MYMCP_` prefix) for connector credentials — only instance config (TIMEZONE, LOCALE, DISPLAY_NAME, CONTEXT_PATH) carries the brand prefix.

---

## Step 5: Test pattern

Create `src/connectors/hello/__tests__/say-hi.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("@/core/fetch-utils", () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchMock(...a),
}));

describe("hello_say_hi", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.HELLO_API_KEY = "test-key";
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.HELLO_API_KEY;
  });

  it("happy path — returns greeting text", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ greeting: "Hello, Alice!" }), { status: 200 })
    );
    const { handler } = await import("../tools/say-hi");
    const result = await handler({ name: "Alice" });
    expect(result.content[0].text).toBe("Hello, Alice!");
  });

  it("401 from API → McpToolError with actionable userMessage", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauth", { status: 401 }));
    const { handler } = await import("../tools/say-hi");
    await expect(handler({ name: "Alice" })).rejects.toThrow(/Hello API/);
  });

  it("missing HELLO_API_KEY → CONFIGURATION_ERROR (not retryable)", async () => {
    delete process.env.HELLO_API_KEY;
    vi.resetModules();
    const { handler } = await import("../tools/say-hi");
    await expect(handler({ name: "Alice" })).rejects.toThrow(/HELLO_API_KEY/);
  });

  it("fetch timeout → EXTERNAL_API_ERROR (retryable)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("AbortError"));
    const { handler } = await import("../tools/say-hi");
    await expect(handler({ name: "Alice" })).rejects.toThrow();
  });
});
```

**Pattern notes:**
- Mock `fetchWithTimeout` at the module boundary, not global `fetch` — more precise, less flaky.
- `vi.resetModules()` between tests when env var changes affect import-time behavior.
- Cover 3+ error paths (auth, timeout, rate-limit) PLUS happy path. Per [CONTRIBUTING.md § Coverage](CONTRIBUTING.md), connector libs carry a ≥ 60% local floor.
- Use `toMsg()` helper from `@/core/error-utils` in your assertions when comparing error messages.

---

## Step 6: Optional — Expose resources

If your connector exposes readable artifacts (files, notes, records), implement the `ResourceProvider` interface (Phase 50 MCP-01) to expose them via the MCP `resources/*` capability.

Create `src/connectors/hello/resources.ts`:

```typescript
import type { ResourceProvider, ResourceSpec, ResourceContent } from "@/core/resources";

export const helloResources: ResourceProvider = {
  scheme: "hello",

  async list(): Promise<ResourceSpec[]> {
    // Return enumeration of URIs. Client will see these in resources/list.
    return [
      {
        uri: "hello://greetings/default",
        name: "Default greeting template",
        description: "The fallback greeting used when no name is provided",
        mimeType: "text/plain",
      },
    ];
  },

  async read(uri: string): Promise<ResourceContent> {
    if (!uri.startsWith("hello://")) {
      throw new Error(`Invalid URI scheme for hello resources: ${uri}`);
    }
    // Parse URI, fetch content, return.
    return {
      uri,
      mimeType: "text/plain",
      text: "Hello, world!",
    };
  },
};
```

Then wire it in your manifest:

```typescript
import { helloResources } from "./resources";

export const helloManifest: ConnectorManifest = {
  // ...existing fields
  resources: helloResources,
};
```

The MCP route handler at `app/api/[transport]/route.ts` iterates enabled connectors and registers resources via `registerResources()` from `@/core/resources`. No additional wiring needed.

**Path-traversal guard:** if your URI scheme encodes filesystem-like paths, reject `..` + absolute paths in `read()`. See `src/connectors/vault/resources.ts` for the reference implementation.

---

## Step 7: Run locally

```bash
npm run dev
```

Visit `http://localhost:3000/config`. Your connector appears in the Connectors tab — enabled if `HELLO_API_KEY` is set, otherwise disabled with "missing env: HELLO_API_KEY" as the reason.

Click **Test** to invoke `testConnection(credentials)`. Click **Save** to persist creds (they flow through EnvStore in dev, Vercel env in prod).

---

## Step 8: Publish

1. `npm test` — all 845+ tests must stay green. Add yours to the count.
2. `npm run lint` — zero errors.
3. `npx tsc --noEmit` — zero errors (4 strict flags active since Phase 49).
4. Commit with conventional-commit format:
   ```
   feat(hello): add hello_say_hi tool + connector scaffold
   ```
5. Open PR. Label with `connector`. Reviewers verify:
   - Contract test passes (`tests/contract/*`)
   - Registry metadata is consistent (`toolCount`, `requiredEnvVars`)
   - No direct `process.env.X` reads (FACADE-03)
   - No ternary error-message pattern (Phase 49 contract test)
   - No stray `mymcp` literals (Phase 50 contract test)

---

## Appendix: Common patterns

### Pagination (cursor-based)

```typescript
// Return the cursor in the response; expose a `cursor?` input param.
const { data, nextCursor } = await api.listItems({ cursor: params.cursor });
return {
  content: [{ type: "text", text: JSON.stringify({ items: data, nextCursor }) }],
};
```

### Per-connector rate limiting (pipeline-step example)

```typescript
// Custom step in src/connectors/hello/pipeline-step.ts — rare; most connectors
// don't need this (the global rate-limit covers 95% of cases). See
// src/core/pipeline/rate-limit-step.ts for the template.
```

### Credential rotation via KV

```typescript
import { getTenantSetting } from "@/core/config-facade";

// Per-tenant credentials fall back to process.env when no tenant override.
const apiKey = await getTenantSetting("HELLO_API_KEY", "secrets:hello_api_key", tenantId);
```

### Tenant-scoped vs operator-wide credentials (Phase 42)

Most connectors use operator-wide env vars (`process.env.SLACK_BOT_TOKEN`). For multi-tenant deploys, use `getTenantKVStore(tenantId).get("secrets:slack_bot_token")` — the Phase 42 TEN-* migrations shipped the dual-read shim that honors tenant-scoped overrides while falling back to env.

### OTel attrs (Phase 50 BRAND-03)

Use the `kebab.<tool>.*` convention via `brandSpanAttrs({ "tool.name": "hello_say_hi" })` rather than hardcoded `kebab.tool.name` — the helper handles the legacy `mymcp.*` emission when `KEBAB_EMIT_LEGACY_OTEL_ATTRS=1` is set.

---

## See also

- [CONNECTORS.md](CONNECTORS.md) — the 14 shipped connectors + 86 tools.
- [API.md](API.md) — route-by-route API reference.
- [CONTRIBUTING.md](CONTRIBUTING.md) — full contribution workflow + coverage philosophy.
- [ARCHITECTURE.md](ARCHITECTURE.md) — full project conventions, env-var reference, and durable-bootstrap pattern.

---

*Last updated: Phase 50 (v0.12).*
