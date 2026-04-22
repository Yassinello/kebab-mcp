import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import kebabPlugin from "./.eslint/plugin-kebab.mjs";

// Minimal Node globals — we don't depend on the `globals` package.
const NODE_GLOBALS = {
  process: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  global: "readonly",
  console: "readonly",
  module: "readonly",
  require: "readonly",
  exports: "writable",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  URL: "readonly",
  fetch: "readonly",
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    plugins: {
      kebab: kebabPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-empty-object-type": "off",
      // Phase 48 / FACADE-03: forbid direct process.env reads outside
      // the ALLOWED_DIRECT_ENV_READS allowlist. Orthogonal to SEC-02's
      // `no-restricted-syntax` assignment guard (below) — assignments
      // vs reads are different concerns.
      "kebab/no-direct-process-env": "error",
      // SEC-02: forbid process.env mutation (concurrency-unsafe under
      // concurrent requests on warm lambdas). Use runWithCredentials()
      // + getCredential() from @/core/request-context instead.
      //
      // Two selectors:
      //  - `process.env.FOO = ...`  (MemberExpression.MemberExpression)
      //  - `process.env[key] = ...` (also MemberExpression.MemberExpression
      //    but with computed=true — the same selector matches both)
      // SEC-02 — forbid process.env mutation (concurrency-unsafe under
      // concurrent requests on warm lambdas). Use runWithCredentials()
      // + getCredential() from @/core/request-context instead.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.object.name='process'][left.object.property.name='env']",
          message:
            "Direct mutation of process.env is forbidden (SEC-02). Use runWithCredentials() + getCredential() from @/core/request-context. See v0.10 CHANGELOG and docs/SECURITY-ADVISORIES.md#sec-02.",
        },
        {
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.name='process'][left.property.name='env']",
          message:
            "Replacing process.env entirely is forbidden. See SEC-02.",
        },
      ],
    },
  },
  // DUR-05 note — previously considered an ESLint advisory rule here.
  // Dropped because ESLint flat-config does not permit two
  // `no-restricted-syntax` entries at different severities without one
  // overwriting the other, and the SEC-02 entry above MUST stay at
  // `error`. The hard gate for DUR-04 is
  // `tests/contract/fire-and-forget.test.ts` — the grep-based contract
  // test catches un-annotated `void <promise>()` in CI and, unlike the
  // AST rule, cannot be bypassed via `eslint-disable` comments.
  //
  // If IDE-time feedback becomes a real operator pain point later, the
  // path forward is a tiny custom ESLint plugin (under
  // `eslint-plugins/no-unannotated-void/`) that inspects preceding
  // comments — out of scope for v0.10.
  // Node globals + CJS allowed for release scripts.
  {
    files: ["scripts/**/*.{js,ts}"],
    languageOptions: {
      globals: NODE_GLOBALS,
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Phase 50 Task 5A (carry-over): .mjs scripts need Node globals
  // (console, process). Pre-Phase-50 config only granted globals to
  // scripts/**/*.{js,ts} — .mjs was silently left without a globals
  // block, which surfaced as 10 no-undef errors on scripts/audit-gate.mjs
  // added in Phase 44. Module sourceType matches the ESM .mjs reality.
  {
    files: ["scripts/**/*.mjs", "*.mjs"],
    languageOptions: {
      globals: NODE_GLOBALS,
      sourceType: "module",
    },
  },
  // create-mymcp is a standalone Node CLI shipped as its own package.
  // v0.6 LOW: flat-config override instead of `/* eslint-env node */`
  // (which flat config no longer supports) — gives the installer the
  // Node globals it needs without polluting the rest of the repo.
  {
    files: ["create-mymcp/**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: NODE_GLOBALS,
      sourceType: "module",
    },
  },
  {
    // `scripts/` used to be globally ignored — they weren't linted even
    // though they're release-critical (contract test, registry test, e2e
    // test, update checker). Lifted in v0.5 phase 13 (GD2). See TECH
    // IMPROVEMENTS report for context.
    ignores: [".next/", "node_modules/"],
  },
  // SEC-02 allowlist: boot-path + scripts + tests may assign to process.env.
  // Boot path: src/core/env-store.ts mutates process.env when the dashboard
  // saves env vars via the FilesystemEnvStore (local dev) — transitional,
  // removed in v0.11. Scripts run in one-shot CLI contexts where process.env
  // races are not a concern. Tests need it for isolation.
  {
    files: [
      "src/core/env-store.ts",
      "scripts/**",
      "tests/**",
      "src/**/*.test.ts",
      "src/**/*.e2e.test.ts",
      "src/core/test-utils.ts",
      "playwright.config.ts",
      "app/api/storage/migrate/route.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  // Phase 48 / FACADE-03 allowlist: boot-path files + scripts + tests are
  // exempt from `kebab/no-direct-process-env`. The list mirrors
  // ALLOWED_DIRECT_ENV_READS in src/core/config-facade.ts (code-review
  // audibility — the lint exemption and the contract are adjacent).
  // Scripts + tests are broadly allowed: one-shot CLI contexts + test
  // isolation fixtures legitimately mutate/read process.env directly.
  {
    files: [
      // Allowlist entries — see ALLOWED_DIRECT_ENV_READS with reasons.
      "src/core/config-facade.ts",
      "src/core/env-store.ts",
      "src/core/first-run.ts",
      "src/core/first-run-edge.ts",
      "src/core/kv-store.ts",
      "src/core/log-store.ts",
      "src/core/request-context.ts",
      "src/core/upstash-env.ts",
      "src/core/signing-secret.ts",
      "src/core/storage-mode.ts",
      "src/core/tracing.ts",
      // Edge runtime middleware — facade module graph not available on Edge.
      "proxy.ts",
      // Infrastructure that needs direct access:
      "scripts/**",
      "tests/**",
      "src/**/*.test.ts",
      "src/**/*.e2e.test.ts",
      "src/core/test-utils.ts",
      "playwright.config.ts",
    ],
    rules: {
      "kebab/no-direct-process-env": "off",
    },
  }
);
