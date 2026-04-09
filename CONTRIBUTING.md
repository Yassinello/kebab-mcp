# Contributing to MyMCP

## Architecture Overview

```
src/
  core/           ← Framework-level code (types, registry, config, auth, logging)
  packs/
    google/       ← Google Workspace pack (18 tools)
    vault/        ← Obsidian Vault pack (15 tools)
    browser/      ← Browser Automation pack (4 tools)
    admin/        ← Admin & Observability pack (1 tool)
```

### Framework vs Instance

**Framework-level** (lives in code, shared by all users):
- Pack manifests, registry logic, types, auth model, dashboard structure

**Instance-level** (lives in env vars, unique per user):
- Secrets, display name, timezone, locale, active packs

**Rule:** If it's personal or changes per deployment, it MUST be an env var, never hardcoded.

## Adding a Tool

1. Create `src/packs/<pack>/tools/my-tool.ts`:

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

2. Add it to the pack manifest (`src/packs/<pack>/manifest.ts`):

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

## Adding a Pack

1. Create directory: `src/packs/mypack/`
2. Create manifest: `src/packs/mypack/manifest.ts` exporting a `PackManifest`
3. Add tools in `src/packs/mypack/tools/`
4. Register in `src/core/registry.ts`:

```typescript
import { myPack } from "@/packs/mypack/manifest";
const ALL_PACKS = [...existing, myPack];
```

5. Document required env vars in `.env.example`

## Code Conventions

- All tool handlers export `{ schema, handler }` pattern
- Every tool is wrapped in `withLogging()` via the registry
- Use `getInstanceConfig()` for timezone/locale, never hardcode
- No personal references in framework code
- TypeScript strict mode, no `any` in public APIs
- Descriptions are generic (no "your", "my", specific names)

## Running Locally

```bash
cp .env.example .env
# Fill in your values
npm install
npm run dev
```

## Commit Convention

```
feat: add new tool/feature
fix: bug fix
refactor: code restructure
docs: documentation changes
chore: maintenance
```
