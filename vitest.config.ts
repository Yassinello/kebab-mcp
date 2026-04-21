import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Integration tests run a real Next.js server (see
    // `vitest.integration.config.ts`) and must stay out of the unit run.
    // The Phase 42 tenant-isolation stitch test is an exception — it
    // exercises multiple modules in-process with no server startup,
    // so it belongs in the main run.
    exclude: [
      "tests/integration/multi-host.test.ts",
      "tests/integration/server-startup.test.ts",
      "tests/integration/welcome-durability.test.ts",
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
    // v0.6 NIT-05: tests historically relied on `http://localhost/...`
    // URLs being recognized as loopback. Production now requires explicit
    // opt-in via MYMCP_TRUST_URL_HOST=1. Set it for the test environment
    // so legacy tests keep their original semantics without rewriting
    // every fixture to add an x-forwarded-for header.
    env: {
      MYMCP_TRUST_URL_HOST: "1",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/test-utils.ts"],
      thresholds: {
        // CI-02 (v0.11 Phase 43): raised from 33 (pre-Phase-43 placeholder)
        // to `floor(actual)` = 46 after measuring against the post-Phase-43
        // codebase. Actual `npm run test:coverage` reports lines=46.45%.
        //
        // Milestone goal is 80% — this is intentionally a RATCHET, not the
        // target. Every PR that adds net-new code must keep the ratio
        // above 46% or add tests. Plan to ratchet upward in v0.12 once the
        // TS-strict migration + coverage-pressure backlog is tackled.
        //
        // NOTE: 80% goal from v0.11 roadmap lines 244-252 is NOT met in
        // Phase 43; documented in 43-03-SUMMARY.md + FOLLOW-UP.md.
        lines: 46,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
