import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["app/**/*.{ts,tsx}", "src/**/*.ts"],
  project: ["app/**/*.{ts,tsx}", "src/**/*.ts"],
  ignoreDependencies: [
    // @opentelemetry/sdk-node provides sdk-trace-node, sdk-trace-base, resources
    // as transitive deps. tracing.ts imports from sub-packages via dynamic require.
    "@opentelemetry/sdk-node",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/resources",
    // postcss is a transitive dep of @tailwindcss/postcss, loaded via config
    "postcss",
    // Tailwind v4 loaded via CSS @import, not a JS import
    "tailwindcss",
    // Testing libs used in test files (excluded from entry points by knip's defaults)
    "@testing-library/jest-dom",
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
};

export default config;
