import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // CI-08 (2026-11 audit): REAL entry points only. The previous
  // `entry: ["app/**", "src/**"]` made every file an entry, so knip could
  // never report a dead file or export — only dependencies were checked.
  entry: [
    // Next.js App Router conventions
    "app/**/{page,layout,route,loading,error,global-error,not-found,template,default}.{ts,tsx}",
    "app/**/{opengraph-image,twitter-image,icon,apple-icon,sitemap,robots,manifest}.{ts,tsx}",
    // Connector manifests are loaded by the registry
    "src/connectors/*/manifest.ts",
    // CLI / CI scripts invoked from package.json, workflows and hooks
    "scripts/*.{ts,js,mjs}",
    // Test suites (vitest / playwright configs + specs)
    "tests/**/*.{ts,tsx}",
    "src/**/*.test.ts",
    "app/**/*.test.{ts,tsx}",
    "vitest*.config.ts",
  ],
  project: ["app/**/*.{ts,tsx}", "src/**/*.ts", "scripts/**/*.{ts,js,mjs}", "tests/**/*.{ts,tsx}"],
  ignoreDependencies: [
    // @opentelemetry/sdk-node provides sdk-trace, resources, core and
    // context-async-hooks as transitive deps (OTel JS v3). tracing.ts imports
    // these sub-packages via dynamic require.
    "@opentelemetry/sdk-node",
    "@opentelemetry/sdk-trace",
    "@opentelemetry/resources",
    "@opentelemetry/core",
    "@opentelemetry/context-async-hooks",
    // postcss is a transitive dep of @tailwindcss/postcss, loaded via config
    "postcss",
    // Tailwind v4 loaded via CSS @import, not a JS import
    "tailwindcss",
    // @composio/json-schema-to-zod is a transitive dep of @composio/core that
    // we import directly in src/connectors/browser/tools/web-extract.ts.
    // Composio re-exports it as a peer-style sub-package; pinning our own
    // version would risk drift from what @composio/core actually ships.
    "@composio/json-schema-to-zod",
    // Testing libs used in test files (excluded from entry points by knip's defaults)
    "@testing-library/user-event",
    // lint-staged is invoked by .husky/pre-commit — knip can't see shell-invoked binaries.
    // Category B (false-positive): legitimate dev-dep used by Husky hooks.
    "lint-staged",
  ],
  ignoreBinaries: [
    // tsx is invoked via npx in package.json scripts
    "tsx",
    // wait-on is used in the Playwright e2e CI workflow (waits for the
    // dev server to come up). Not in package.json scripts, invoked via npx.
    "wait-on",
  ],
  // Knip scans `.husky/pre-commit` as a plugin entry and can't trace the
  // `npx lint-staged` shell invocation. Disable the husky plugin so the
  // hook file is ignored entirely. `lint-staged` is kept in
  // ignoreDependencies above so it isn't flagged as an unused dev-dep.
  husky: false,
  // Exports referenced elsewhere in their own module are not dead code.
  ignoreExportsUsedInFile: true,
  // TODO(CI-08, 2026-11 audit): baseline of findings from the first run with
  // real entry points (2 files, 15 exports, 7 types). They are ignored
  // per-file so CI stays green WITHOUT deleting application code in the
  // tooling PR; any NEW dead file/export elsewhere fails the gate. Burn this
  // list down (delete the code or un-export it) and remove entries as you go.
  ignore: [
    // Unreferenced component (no importer under app/).
    "app/config-block.tsx",
    // Shadowed barrel: `@/core/pipeline` resolves to src/core/pipeline.ts,
    // so this index.ts is never loaded.
    "src/core/pipeline/index.ts",
  ],
  ignoreIssues: {
    "app/config/pack-defs.tsx": ["exports"], // cleanCredential
    "src/connectors/browser/tools/linkedin-feed.ts": ["exports"], // linkedinFeedSchema
    "src/connectors/composio/tools/composio-action.ts": ["exports"], // composioActionSchema
    "src/connectors/composio/tools/composio-list.ts": ["exports"], // composioListSchema
    "src/connectors/custom-tools/cost.ts": ["exports"], // _*_FOR_TESTS test hooks
    "src/connectors/custom-tools/rate-limit.ts": ["exports"], // _SCOPE_FOR_TESTS
    "src/connectors/linear/lib/linear-api.ts": ["exports"], // PRIORITY_LABELS
    "src/core/config-facade.ts": ["exports"], // __*ForTests hooks
    "src/core/config.ts": ["exports"], // getErrorWebhookUrl
    "src/core/migrations/v0.10-tenant-prefix.ts": ["exports"], // __resetV010MigrationForTests
    "src/core/registry.ts": ["exports"], // __validateRegisterPromptsForTests, getEnabledPacks
    "src/core/storage-mode.ts": ["exports"], // getCachedStorageMode
    "src/connectors/api/store.ts": ["types"], // ApiAuth, ApiToolArg
    "src/connectors/custom-tools/types.ts": ["types"], // CustomTool{Tool,Transform}Step
    "src/connectors/skills/store.ts": ["types"], // SkillArgument, SkillSource
    "src/core/pipeline/types.ts": ["types"], // StepResult
  },
};

export default config;
