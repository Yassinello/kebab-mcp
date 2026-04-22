import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * UI-test isolation config (Phase 45 Task 7, QA-01).
 *
 * Addresses the 4 flaky render tests across `tests/components/*.tsx`
 * + `tests/ui/config-health-tab.test.tsx` that intermittently timed
 * out under the default vitest pool due to: (1) jsdom setup racing
 * `vi.mock()` substitution for `next/dynamic` imports, (2) PERF-01
 * lazy-registry shared module cache across workers, (3)
 * setState-on-unmount warnings leaking into assertion paths.
 *
 * Fix: run UI + component tests in a forked pool with a single fork
 * (`pool: 'forks'` + `singleFork: true`) under jsdom. Eliminates the
 * cross-worker module cache + keeps jsdom instances serialized
 * within one worker process. Timeout raised to 10 s so slow CI
 * runners don't surface false positives.
 *
 * Invocation (wired into `npm test` via package.json):
 *   npx vitest run --config vitest.ui.config.ts
 *
 * Standalone config (not `mergeConfig` with base) — the base config's
 * `include` glob would pull in all src/ + tests/ test files under
 * jsdom, which breaks the node-env tests (e.g. `src/core/url-safety.test.ts`
 * uses `import.meta.url` parsing that jsdom doesn't provide). We
 * deliberately scope this config to ONLY the render-heavy test tree.
 *
 * The default `vitest.config.ts` excludes `tests/components/**` and
 * `tests/ui/**` so render tests don't run twice.
 */
// Phase 50 Task 5C (carry-over): vitest 4 REMOVED `test.poolOptions`
// and promoted pool-specific config to TOP-LEVEL `forks` / `threads`
// options. Pre-Phase-50 config had `pool: "forks" + poolOptions.forks`
// which worked at runtime but emitted a loud DEPRECATED warning on
// every `npm test` invocation. See
// https://vitest.dev/guide/migration#pool-rework.
//
// Type cast: vitest 4's public InlineConfig TypeScript export does not
// (yet) include the new top-level `forks` key, even though the runtime
// accepts it. The cast defers to the runtime-verified shape; drop the
// cast once vitest's types catch up.
export default defineConfig({
  test: {
    name: "ui",
    environment: "jsdom",
    include: ["tests/components/**/*.test.tsx", "tests/ui/**/*.test.tsx", "tests/ui/**/*.test.ts"],
    pool: "forks",
    forks: {
      singleFork: true,
    },
    testTimeout: 10_000,
    fileParallelism: false,
    env: {
      // Phase 50 / BRAND-01: use KEBAB_* so the alias resolver doesn't
      // fire a deprecation warning on every test process.
      KEBAB_TRUST_URL_HOST: "1",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
} as Parameters<typeof defineConfig>[0]);
