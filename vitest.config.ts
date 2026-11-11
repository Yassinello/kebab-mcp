import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      // Phase 70 Plan 01 UNI-12: webhook route tests live co-located under
      // `app/api/unipile/webhook/__tests__/` (same convention as `src/`
      // module-co-located tests). This glob picks up any future co-located
      // route tests without further config churn.
      "app/**/*.test.ts",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
    // Integration tests run a real Next.js server (see
    // `vitest.integration.config.ts`) and must stay out of the unit run.
    // The Phase 42 tenant-isolation stitch test is an exception — it
    // exercises multiple modules in-process with no server startup,
    // so it belongs in the main run.
    exclude: [
      "tests/integration/multi-host.test.ts",
      "tests/integration/server-startup.test.ts",
      "tests/integration/welcome-durability.test.ts",
      // Phase 46 CORR-01..05: the init-concurrency suite mocks KV at
      // the module boundary and races two POST handlers through
      // vi.resetModules() — it only belongs in `npm run test:integration`,
      // where fileParallelism is off and each test file owns its module
      // graph. Running it under the default pool collides with other
      // first-run tests that import `@/core/first-run` and `@/core/kv-store`
      // directly.
      "tests/integration/welcome-init-concurrency.test.ts",
      // QA-01 (Phase 45 Task 7): UI + component render tests run under
      // the isolated forked pool via `vitest.ui.config.ts`. Excluding
      // them here prevents double-execution when `npm test` chains both
      // configs. Pure-module tests (wizard-steps.test.ts, hook renderHook
      // tests) live under tests/ui/ too, but they get the isolated pool
      // treatment anyway — cost is a few hundred ms, benefit is one
      // command.
      "tests/components/**/*.test.tsx",
      "tests/ui/**/*.test.tsx",
    ],
    // first-run tests share OS /tmp paths; run files sequentially to avoid
    // cross-worker races on BOOTSTRAP_PATH.
    fileParallelism: false,
    // PERF-01 (v0.11 Phase 43): first registry resolve in a fresh vitest
    // worker pays a 5-8s one-time cost to transform + load all 14
    // connector manifests through tsx/vite. Subsequent resolves hit the
    // in-process cache. 15s gives headroom on slower CI runners without
    // masking genuine test hangs.
    testTimeout: 15_000,
    // CI-05 (2026-11 audit): hermeticity. Every vi.stubEnv / vi.stubGlobal
    // is reverted after each test so one test's env/global stubs can't leak
    // into the next. Prefer vi.stubEnv over mutating process.env directly.
    unstubEnvs: true,
    unstubGlobals: true,
    // v0.6 NIT-05: tests historically relied on `http://localhost/...`
    // URLs being recognized as loopback. Production now requires explicit
    // opt-in via MYMCP_TRUST_URL_HOST=1. Set it for the test environment
    // so legacy tests keep their original semantics without rewriting
    // every fixture to add an x-forwarded-for header.
    env: {
      // Phase 50 / BRAND-01: use KEBAB_* so the alias resolver doesn't
      // fire a deprecation warning on every test process.
      KEBAB_TRUST_URL_HOST: "1",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/test-utils.ts"],
      thresholds: {
        // Phase 50 / COV-02: ratchet raised to 50. Measured global
        // lines=55.01% post-Phase-50 (after vault/apify/slack/google
        // connector-lib backfill + proxy behavioral + BRAND/*
        // tests = +60 new tests). floor(actual) = 55 is the aggressive
        // ratchet; 50 is the conservative floor that still catches
        // net-new-code regressions without fighting connector churn.
        //
        // Priority-path coverage (welcome / auth / first-run /
        // signing-secret / kv-store / pipeline / rate-limit /
        // credential-store / transport) is enforced by the
        // risk-weighted approach documented in CONTRIBUTING.md —
        // see also the per-path assertion in the coverage verify step.
        //
        // Ratchet discipline (Phase 43 precedent): every PR keeps the
        // line ratio >= 50 or adds tests. Phase 51+ may ratchet upward.
        lines: 50,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
